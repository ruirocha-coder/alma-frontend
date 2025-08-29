"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_GLTF_URL ||
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL || // fallback antigo
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb?morphTargets=ARKit";

/** Conveniência: encontra index de um morph target por nome (case-insensitive, aceita “mixamorig:” etc). */
function findMorphIndex(mesh: THREE.Mesh, names: string[]): number | null {
  const dict: Record<string, number> | undefined = (mesh as any).morphTargetDictionary;
  if (!dict) return null;
  const lc = Object.fromEntries(
    Object.entries(dict).map(([k, v]) => [k.toLowerCase(), v as number])
  );
  for (const n of names) {
    const i = lc[n.toLowerCase()];
    if (i !== undefined) return i;
  }
  // tenta correspondências parciais (p.ex. “mouthsmileleft”)
  for (const [k, v] of Object.entries(lc)) {
    if (names.some((n) => k.includes(n.toLowerCase()))) return v;
  }
  return null;
}

export default function AvatarCanvas() {
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
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
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
    dir.castShadow = false;
    scene.add(dir);

    // Controlo (limitado)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;
    let headBone: THREE.Object3D | null = null;

    // Guardaremos os meshes que têm morph targets relevantes
    type DrivenMesh = {
      mesh: THREE.Mesh;
      idx: {
        jawOpen?: number;
        mouthFunnel?: number;
        mouthPucker?: number;
        mouthSmileL?: number;
        mouthSmileR?: number;
        browInnerUp?: number;
        eyeBlinkL?: number;
        eyeBlinkR?: number;
      };
      influences: number[]; // referência ao array original para escrita rápida
    };
    const driven: DrivenMesh[] = [];

    // --- Áudio / lipsync (Web Audio) ---
    let audioEl: HTMLAudioElement | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let dataTime: Uint8Array | null = null;

    // envelope e smoothing
    let env = 0; // 0..1
    const attack = 0.6; // subida mais “presa” para estabilidade
    const release = 0.15; // queda mais rápida
    let speaking = false;

    // blink
    let blinkT = 0;
    let nextBlinkAt = 0.9 + Math.random() * 2.2; // em segundos
    let blinkAmt = 0; // 0..1

    // head-bob
    let headPhase = 0;

    function setupAudioGraph() {
      // procurar <audio id="alma-tts"> criado no page
      audioEl = document.getElementById("alma-tts") as HTMLAudioElement | null;
      if (!audioEl) return;

      // cria (ou reutiliza) audio context
      if (!audioCtx) {
        const AC = (window.AudioContext || (window as any).webkitAudioContext);
        audioCtx = new AC();
      }
      // Em iOS é preciso um gesto do utilizador para desbloquear:
      try { audioCtx.resume(); } catch {}

      const source = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;
      dataTime = new Uint8Array(analyser.fftSize);

      // não ligamos ao destination (sem eco); só analisamos
      source.connect(analyser);

      // heurística de “speaking” — quando o áudio tocar, marcamos speaking true
      audioEl.addEventListener("play", () => { speaking = true; });
      audioEl.addEventListener("ended", () => { speaking = false; env = 0; });
      audioEl.addEventListener("pause", () => { speaking = false; });
    }

    // Função util para zero a todas as influências que animamos (evita acumular)
    function zeroInfluences() {
      for (const d of driven) {
        const infl = d.mesh.morphTargetInfluences!;
        if (d.idx.jawOpen !== undefined) infl[d.idx.jawOpen] = 0;
        if (d.idx.mouthFunnel !== undefined) infl[d.idx.mouthFunnel] = 0;
        if (d.idx.mouthPucker !== undefined) infl[d.idx.mouthPucker] = 0;
        if (d.idx.mouthSmileL !== undefined) infl[d.idx.mouthSmileL] = 0;
        if (d.idx.mouthSmileR !== undefined) infl[d.idx.mouthSmileR] = 0;
        if (d.idx.browInnerUp !== undefined) infl[d.idx.browInnerUp] = 0;
        if (d.idx.eyeBlinkL !== undefined) infl[d.idx.eyeBlinkL] = 0;
        if (d.idx.eyeBlinkR !== undefined) infl[d.idx.eyeBlinkR] = 0;
      }
    }

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // Esconder mãos / ajustar material
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
              // activa morphTargets se existir
              o.material.morphTargets = true;
            }
          }
        });

        // Encontrar cabeça (irá levar head-bob suave)
        headBone =
          avatar.getObjectByName("Head") ||
          avatar.getObjectByName("head") ||
          avatar.getObjectByName("HeadMesh") ||
          null;

        // Normalizar escala ~1.75m
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const h = tmpSize.y || 1;
        avatar.scale.setScalar(1.75 / h);

        scene.add(avatar);

        // Detetar meshes com morph targets ARKit
        avatar.traverse((o: any) => {
          if (!(o as THREE.Mesh).morphTargetInfluences) return;
          const mesh = o as THREE.Mesh;
          const idx = {
            jawOpen: findMorphIndex(mesh, ["jawOpen"]),
            mouthFunnel: findMorphIndex(mesh, ["mouthFunnel"]),
            mouthPucker: findMorphIndex(mesh, ["mouthPucker"]),
            mouthSmileL: findMorphIndex(mesh, ["mouthSmileLeft", "mouthSmile_L", "mouthSmileLeftARKit"]),
            mouthSmileR: findMorphIndex(mesh, ["mouthSmileRight", "mouthSmile_R", "mouthSmileRightARKit"]),
            browInnerUp: findMorphIndex(mesh, ["browInnerUp"]),
            eyeBlinkL: findMorphIndex(mesh, ["eyeBlinkLeft"]),
            eyeBlinkR: findMorphIndex(mesh, ["eyeBlinkRight"]),
          };
          if (
            idx.jawOpen !== null ||
            idx.mouthFunnel !== null ||
            idx.mouthPucker !== null ||
            idx.mouthSmileL !== null ||
            idx.mouthSmileR !== null ||
            idx.browInnerUp !== null ||
            idx.eyeBlinkL !== null ||
            idx.eyeBlinkR !== null
          ) {
            driven.push({ mesh, idx, influences: mesh.morphTargetInfluences! });
          }
        });

        // Enquadrar câmara (ombros/cabeça)
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.7,
          zoomFactor: 0.6,
        });

        // Criar grafo de áudio
        setupAudioGraph();
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
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    // Loop
    let raf = 0;
    let lastT = performance.now();

    const tick = () => {
      const now = performance.now();
      const dt = Math.max(0, (now - lastT) / 1000);
      lastT = now;

      // áudio → envelope
      if (analyser && dataTime) {
        analyser.getByteTimeDomainData(dataTime);
        // RMS simples normalizado
        let sum = 0;
        for (let i = 0; i < dataTime.length; i++) {
          const v = (dataTime[i] - 128) / 128.0;
          sum += v * v;
        }
        let rms = Math.sqrt(sum / dataTime.length); // ~0..1
        // compressão para resposta mais “humana”
        rms = Math.pow(rms, 0.6);

        // smoothing attack/release
        const target = rms;
        env =
          target > env
            ? env + (target - env) * attack * dt * 8
            : env + (target - env) * release * dt * 8;

        // anima blendshapes
        zeroInfluences();

        const talk = speaking ? env : 0;

        for (const d of driven) {
          const infl = d.influences;

          // Boca principal
          if (d.idx.jawOpen !== undefined) {
            infl[d.idx.jawOpen] = THREE.MathUtils.clamp(talk * 1.3, 0, 1);
          }
          // Formantes — dá forma “funnel/pucker” quando energia é média/alta
          const formant = Math.max(0, talk - 0.25) * 1.4;
          if (d.idx.mouthFunnel !== undefined) infl[d.idx.mouthFunnel] = THREE.MathUtils.clamp(formant * 0.6, 0, 1);
          if (d.idx.mouthPucker !== undefined) infl[d.idx.mouthPucker] = THREE.MathUtils.clamp(formant * 0.35, 0, 1);

          // Sorriso subtil com fala (faz a boca menos “neutra”)
          const smile = THREE.MathUtils.clamp(Math.max(0, talk - 0.15) * 0.5, 0, 0.4);
          if (d.idx.mouthSmileL !== undefined) infl[d.idx.mouthSmileL] = smile;
          if (d.idx.mouthSmileR !== undefined) infl[d.idx.mouthSmileR] = smile;

          // Sobrancelha sobe um pouco quando há fala
          const brow = THREE.MathUtils.clamp(talk * 0.35, 0, 0.5);
          if (d.idx.browInnerUp !== undefined) infl[d.idx.browInnerUp] = brow;

          // Pestanejar natural com ruído + baixa probabilidade
          blinkT += dt;
          if (blinkT > nextBlinkAt) {
            // rápido “blink”
            blinkAmt = 1;
            nextBlinkAt = 2.0 + Math.random() * 3.0;
            blinkT = 0;
          }
          // decaimento do blink
          blinkAmt = Math.max(0, blinkAmt - dt * 3.5);

          const eye = THREE.MathUtils.clamp(blinkAmt, 0, 1);
          if (d.idx.eyeBlinkL !== undefined) infl[d.idx.eyeBlinkL] = eye;
          if (d.idx.eyeBlinkR !== undefined) infl[d.idx.eyeBlinkR] = eye;
        }

        // Head-bob muito subtil
        if (headBone) {
          headPhase += dt * (speaking ? 6 : 1.5);
          const amp = speaking ? 0.015 : 0.005;
          headBone.rotation.x = Math.sin(headPhase * 0.8) * amp;
          headBone.rotation.y = Math.sin(headPhase * 0.5) * amp * 0.6;
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
      try { renderer.dispose(); } catch {}
      scene.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
      if (renderer.domElement && renderer.domElement.parentElement === el) {
        el.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

/** Enquadra a câmara ao objeto com margem e um “zoomFactor” extra. */
function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  controls: OrbitControls,
  renderer: THREE.WebGLRenderer,
  {
    padding = 1.0,      // margem (1 = sem margem extra)
    yFocusBias = 0.5,   // foca mais acima (0 = centro, 1 = topo)
    zoomFactor = 0.7,   // < 1 aproxima mais; > 1 afasta
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
