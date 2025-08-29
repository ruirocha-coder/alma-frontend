"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Props = {
  /** Opcional: nível RMS externo (0..1) para animar cabeça/smile, se quiseres. */
  audioLevelRef?: React.RefObject<number>;
};

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_GLTF_URL ||
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

/** Enquadra a câmara ao objeto com margem e um “zoomFactor” extra. */
function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  controls: OrbitControls,
  renderer: THREE.WebGLRenderer,
  {
    padding = 1.0,
    yFocusBias = 0.5,
    zoomFactor = 0.7,
  }: { padding?: number; yFocusBias?: number; zoomFactor?: number }
) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const target = center.clone();
  target.y += size.y * (yFocusBias - 0.5);

  const fov = (camera.fov * Math.PI) / 180;
  const height = size.y * padding;
  const width = size.x * padding;
  const distForHeight = height / (2 * Math.tan(fov / 2));
  const distForWidth = width / (2 * Math.tan((fov * camera.aspect) / 2));
  let distance = Math.max(distForHeight, distForWidth);

  distance *= zoomFactor;

  const dir = new THREE.Vector3(0, 0.12, 1).normalize();
  const newPos = target.clone().add(dir.multiplyScalar(distance));

  camera.position.copy(newPos);
  camera.near = Math.max(0.01, distance / 100);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(target);
  controls.update();

  renderer.render(object.parent as THREE.Scene, camera);
}

export default function AvatarCanvas({ audioLevelRef }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current!;
    const width = el.clientWidth;
    const height = el.clientHeight;

    // Cena
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0b0b");

    // Câmara
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1.6, 2.0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    // Luzes
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    hemi.position.set(0, 2, 0);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 4, 2);
    scene.add(dir);

    // Controlo de órbita (limitado)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;
    let jawIndex = -1;
    let funnelIndex = -1;
    let puckerIndex = -1;
    let smileLIndex = -1;
    let smileRIndex = -1;
    let browUpLIndex = -1;
    let browUpRIndex = -1;
    let blinkLIndex = -1;
    let blinkRIndex = -1;

    // Áudio do TTS
    const ttsEl = document.getElementById("alma-tts") as HTMLAudioElement | null;
    const audioCtx =
      (window as any).webkitAudioContext
        ? new (window as any).webkitAudioContext()
        : new AudioContext();
    let analyser: AnalyserNode | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    const spectrum = new Uint8Array(64);

    function connectAudio() {
      if (!ttsEl) return;
      try {
        if (!source) {
          source = audioCtx.createMediaElementSource(ttsEl);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          source.connect(analyser);
          analyser.connect(audioCtx.destination);
        }
      } catch {
        // Se falhar (p.ex. já ligado), ignorar
      }
    }

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // Esconder mãos
        avatar.traverse((o: any) => {
          const n = (o.name || "").toLowerCase();
          if (n.includes("hand") || n.includes("wrist") || n.includes("wolf3d_hands")) {
            o.visible = false;
          }
          if (o.isMesh) {
            o.castShadow = false;
            o.receiveShadow = false;
            if (o.material?.isMeshStandardMaterial) {
              o.material.roughness = 0.75;
              o.material.metalness = 0.05;
            }
          }
        });

        // Normalizar escala ~1.75m
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);

        scene.add(avatar);

        // Encontrar blendshapes ARKit
        avatar.traverse((obj: any) => {
          if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
            const dict = obj.morphTargetDictionary as Record<string, number>;
            if (dict["jawOpen"] !== undefined) jawIndex = dict["jawOpen"];
            if (dict["mouthFunnel"] !== undefined) funnelIndex = dict["mouthFunnel"];
            if (dict["mouthPucker"] !== undefined) puckerIndex = dict["mouthPucker"];
            if (dict["mouthSmileLeft"] !== undefined) smileLIndex = dict["mouthSmileLeft"];
            if (dict["mouthSmileRight"] !== undefined) smileRIndex = dict["mouthSmileRight"];
            if (dict["browInnerUp"] !== undefined) {
              // alguns rigs usam innerUp; outros browOuterUp*
              browUpLIndex = dict["browInnerUp"];
              browUpRIndex = dict["browInnerUp"];
            }
            if (dict["eyeBlinkLeft"] !== undefined) blinkLIndex = dict["eyeBlinkLeft"];
            if (dict["eyeBlinkRight"] !== undefined) blinkRIndex = dict["eyeBlinkRight"];
          }
        });

        // Enquadrar cabeça/ombros
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.7,
          zoomFactor: 0.6,
        });

        // Conectar áudio após interação
        const resumeAudio = () => {
          audioCtx.resume().catch(() => {});
          connectAudio();
          document.removeEventListener("click", resumeAudio);
          document.removeEventListener("touchstart", resumeAudio);
        };
        document.addEventListener("click", resumeAudio, { once: true });
        document.addEventListener("touchstart", resumeAudio, { once: true });
      },
      undefined,
      (err) => console.error("Falha a carregar GLB:", err)
    );

    // Resize
    const onResize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (avatar) {
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.7,
          zoomFactor: 0.6,
        });
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    // Loop
    let raf = 0;
    let headPhase = 0;

    const tick = () => {
      controls.update();

      // lipsync & expressões
      if (avatar && analyser && ttsEl) {
        analyser.getByteFrequencyData(spectrum);
        const avg =
          spectrum.reduce((a, b) => a + b, 0) / Math.max(1, spectrum.length) / 255; // 0..1
        const rmsExternal = audioLevelRef?.current ?? 0;

        const energy = Math.max(avg, rmsExternal); // usa externo se existir

        // influência principal: abrir a mandíbula
        const jaw = THREE.MathUtils.clamp(energy * 1.8, 0, 1);
        const mixSmile = THREE.MathUtils.clamp(energy * 0.6, 0, 0.35);
        const funnel = THREE.MathUtils.clamp(energy * 0.9, 0, 0.6);
        const pucker = THREE.MathUtils.clamp(energy * 0.7, 0, 0.5);
        const brow = THREE.MathUtils.clamp(energy * 0.4, 0, 0.35);
        const blink = Math.random() < 0.006 ? 1 : 0; // pestanejo ocasional

        avatar.traverse((obj: any) => {
          if (obj.isMesh && obj.morphTargetInfluences) {
            const inf = obj.morphTargetInfluences as number[];

            if (jawIndex >= 0) inf[jawIndex] = jaw;
            if (funnelIndex >= 0) inf[funnelIndex] = funnel * 0.4;
            if (puckerIndex >= 0) inf[puckerIndex] = pucker * 0.35;
            if (smileLIndex >= 0) inf[smileLIndex] = mixSmile;
            if (smileRIndex >= 0) inf[smileRIndex] = mixSmile;
            if (browUpLIndex >= 0) inf[browUpLIndex] = brow;
            if (browUpRIndex >= 0) inf[browUpRIndex] = brow;
            if (blinkLIndex >= 0) inf[blinkLIndex] = blink;
            if (blinkRIndex >= 0) inf[blinkRIndex] = blink;
          }
        });

        // head bob muito subtil quando há voz
        const head = avatar.getObjectByName("Head") || avatar;
        headPhase += energy * 0.1;
        const nod = Math.sin(headPhase * 6) * energy * 0.02; // ± ~1.1°
        head.rotation.x = nod;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeChild(renderer.domElement);
      renderer.dispose();
      scene.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
      try { source?.disconnect(); } catch {}
      try { analyser?.disconnect(); } catch {}
      try { audioCtx?.close(); } catch {}
    };
  }, [audioLevelRef]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
