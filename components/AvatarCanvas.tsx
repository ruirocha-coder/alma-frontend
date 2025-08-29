"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

/** Morph targets candidatos típicos em Ready Player Me / rigs comuns */
const MOUTH_CANDIDATES = [
  "jawOpen",
  "mouthOpen",
  "viseme_aa",
  "viseme_AA",
  "viseme_O",
  "viseme_CH",
] as const;

/** Enquadra a câmara ao objeto com margem e um “zoomFactor” extra. */
function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  controls: OrbitControls,
  renderer: THREE.WebGLRenderer,
  {
    padding = 1.0, // margem (1 = sem margem extra)
    yFocusBias = 0.5, // foca mais acima (0 = centro, 1 = topo)
    zoomFactor = 0.7, // < 1 aproxima mais; > 1 afasta
  }: { padding?: number; yFocusBias?: number; zoomFactor?: number }
) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // alvo: um pouco acima do centro (cabeça/ombros)
  const target = center.clone();
  target.y += size.y * (yFocusBias - 0.5); // mover para cima

  const fov = (camera.fov * Math.PI) / 180;
  const height = size.y * padding;
  const width = size.x * padding;
  const distForHeight = height / (2 * Math.tan(fov / 2));
  const distForWidth = width / (2 * Math.tan((fov * camera.aspect) / 2));
  let distance = Math.max(distForHeight, distForWidth);

  // aplica zoom extra
  distance *= zoomFactor;

  // ligeiro ângulo superior
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

type Props = {
  /** Chamado quando o avatar está pronto. Recebe uma função para anexar o <audio> do TTS. */
  onAttachReady?: (attachAudioElement: (audioEl: HTMLAudioElement) => void) => void;
};

/**
 * Mantém todo o teu setup (THREE puro) e acrescenta:
 * - deteção de morph targets de boca
 * - WebAudio Analyser ligado ao <audio> do TTS
 * - lip-sync por RMS (abre/fecha a boca pelo volume)
 */
export default function AvatarCanvas({ onAttachReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // refs do THREE / avatar
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const avatarRef = useRef<THREE.Group | null>(null);

  // morph targets encontradas
  const mouthTargetsRef = useRef<
    { infl: number[]; dict: Record<string, number> }[]
  >([]);

  // Analyser / lip-sync
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeDataRef = useRef<Uint8Array | null>(null);
  const volSmoothedRef = useRef(0);

  // função para ligar um <audio> ao analyser (exposta via onAttachReady)
  function attachAudioElement(audioEl: HTMLAudioElement) {
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx =
          new (window.AudioContext || (window as any).webkitAudioContext)({
            latencyHint: "interactive",
          });
        audioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") {
        // iOS: desbloquear após gesto
        const resume = () => ctx!.resume().catch(() => {});
        window.addEventListener("touchstart", resume, { once: true });
        window.addEventListener("click", resume, { once: true });
      }

      const src = ctx.createMediaElementSource(audioEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;

      src.connect(analyser);
      // ligar também ao destino (caso o <audio> esteja muted/sem autoplay)
      analyser.connect(ctx.destination);

      analyserRef.current = analyser;
      timeDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      console.warn("⚠️ Falha a montar analyser WebAudio:", e);
    }
  }

  useEffect(() => {
    const el = containerRef.current!;
    const width = el.clientWidth;
    const height = el.clientHeight;

    // Cena
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0b0b");
    sceneRef.current = scene;

    // Câmara
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1.6, 2.0);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

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
    controlsRef.current = controls;

    // Carregar GLB
    const loader = new GLTFLoader();

    loader.load(
      AVATAR_URL,
      (gltf) => {
        const avatar = gltf.scene as THREE.Group;
        avatarRef.current = avatar;

        // Esconder mãos & pequenos ajustes nos materiais
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
            // guardar morph targets de interesse
            if (o.morphTargetDictionary && o.morphTargetInfluences) {
              mouthTargetsRef.current.push({
                dict: o.morphTargetDictionary as Record<string, number>,
                infl: o.morphTargetInfluences as number[],
              });
            }
          }
        });

        // Normalizar escala para ~1.75m de altura
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);

        scene.add(avatar);

        // Enquadrar mais próximo e focado na cabeça
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95, // pouca margem
          yFocusBias: 0.7, // foca bem alto (cabeça)
          zoomFactor: 0.6, // aproxima
        });

        // Avatar pronto → expor attachAudioElement
        onAttachReady?.(attachAudioElement);
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

      if (avatarRef.current) {
        fitCameraToObject(camera, avatarRef.current, controls, renderer, {
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
    const tick = () => {
      // Lip-sync por RMS
      const analyser = analyserRef.current;
      const td = timeDataRef.current;
      if (analyser && td && mouthTargetsRef.current.length) {
        analyser.getByteTimeDomainData(td);
        // RMS simples
        let sum = 0;
        for (let i = 0; i < td.length; i++) {
          const v = (td[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / td.length);
        // mapear para [0..1] com threshold e easing
        const raw = Math.min(1, Math.max(0, (rms - 0.02) * 6)); // threshold ~0.02
        volSmoothedRef.current = volSmoothedRef.current * 0.8 + raw * 0.2;

        // Aplicar no primeiro morph target encontrado entre os candidatos
        for (const { dict, infl } of mouthTargetsRef.current) {
          let idx = -1;
          for (const k of MOUTH_CANDIDATES) {
            if (dict[k] !== undefined) {
              idx = dict[k];
              break;
            }
          }
          if (idx >= 0 && infl[idx] !== undefined) {
            infl[idx] = volSmoothedRef.current;
          }
        }
      } else {
        // sem audio → relaxar boca
        for (const { dict, infl } of mouthTargetsRef.current) {
          let idx = -1;
          for (const k of MOUTH_CANDIDATES) {
            if (dict[k] !== undefined) {
              idx = dict[k];
              break;
            }
          }
          if (idx >= 0 && infl[idx] !== undefined) {
            infl[idx] *= 0.9;
          }
        }
      }

      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        if (renderer.domElement.parentElement === el) {
          el.removeChild(renderer.domElement);
        }
      } catch {}
      renderer.dispose();
      scene.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
      try {
        analyserRef.current?.disconnect();
        audioCtxRef.current?.close();
      } catch {}
    };
  }, [onAttachReady]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
