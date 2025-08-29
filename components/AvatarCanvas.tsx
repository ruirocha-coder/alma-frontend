"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Props = {
  /** Valor 0..1 opcional vindo do Page para abrir/fechar a boca (tem prioridade). */
  audioLevelRef?: React.RefObject<number>;
};

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_GLTF_URL ||
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  // Recomendo exportar com ARKit: …glb?morphTargets=ARKit
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb?morphTargets=ARKit";

type MeshWithMorph = THREE.Mesh & {
  morphTargetDictionary?: { [name: string]: number };
  morphTargetInfluences?: number[];
};

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  controls: OrbitControls,
  renderer: THREE.WebGLRenderer,
  {
    padding = 0.95,
    yFocusBias = 0.7,
    zoomFactor = 0.6,
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
  let distance = Math.max(distForHeight, distForWidth) * zoomFactor;

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

/** Procura o primeiro morph existente numa lista de nomes. */
function findMorphIndex(mesh: MeshWithMorph, candidates: string[]) {
  if (!mesh.morphTargetDictionary) return -1;
  for (const name of candidates) {
    const idx = mesh.morphTargetDictionary[name];
    if (typeof idx === "number") return idx;
  }
  return -1;
}

/** LERP com clamp. */
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export default function AvatarCanvas({ audioLevelRef }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current!;
    const width = el.clientWidth;
    const height = el.clientHeight;

    // Scene / Camera / Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0b0b");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1.6, 2.0);

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

    // Controlo
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Áudio (analyser) — MESMA base + robustez iOS
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let dataArray: Uint8Array | null = null;
    let mediaElSource: MediaElementAudioSourceNode | null = null;
    let zeroGain: GainNode | null = null;

    function connectToTTSAudio() {
      const elAudio = document.getElementById("alma-tts") as HTMLAudioElement | null;
      if (!elAudio) {
        setTimeout(connectToTTSAudio, 400);
        return;
      }
      try {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.minDecibels = -85;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.6;
        dataArray = new Uint8Array(analyser.frequencyBinCount);

        mediaElSource = audioCtx.createMediaElementSource(elAudio);

        // zero-gain para manter o grafo “vivo” no iOS sem eco
        zeroGain = audioCtx.createGain();
        zeroGain.gain.value = 0;

        mediaElSource.connect(analyser);
        analyser.connect(zeroGain);
        zeroGain.connect(audioCtx.destination);

        // garantir resume() após gesto do utilizador
        const tryResume = async () => {
          if (!audioCtx) return;
          if (audioCtx.state !== "running") {
            try { await audioCtx.resume(); } catch {}
          }
        };
        elAudio.addEventListener("play", tryResume);
        document.addEventListener("click", tryResume, { once: true });
        document.addEventListener("touchstart", tryResume, { once: true });
      } catch (e) {
        console.warn("Não consegui ligar Analyser ao audio do TTS:", e);
      }
    }

    // Morph targets e bones
    const mouthCandidates = [
      "jawOpen",
      "mouthOpen",
      "viseme_aa",
      "MouthOpen",
      "mouthOpen_BS",
      "CC_Base_BlendShape.MouthOpen",
      "Wolf3D_Avatar.MouthOpen",
    ];
    // Expressões ARKit (nomes comuns RPM/ARKit)
    const browUpCandidates = ["browInnerUp", "browOuterUpLeft", "browOuterUpRight"];
    const browDownLCandidates = ["browDownLeft"];
    const browDownRCandidates = ["browDownRight"];
    const eyeBlinkLCandidates = ["eyeBlinkLeft"];
    const eyeBlinkRCandidates = ["eyeBlinkRight"];
    const eyeWideLCandidates = ["eyeWideLeft"];
    const eyeWideRCandidates = ["eyeWideRight"];
    const smileLCandidates = ["mouthSmileLeft"];
    const smileRCandidates = ["mouthSmileRight"];

    let mouthMeshes: MeshWithMorph[] = [];
    let mouthMorphIndices: number[] = [];
    let exprMeshes: MeshWithMorph[] = []; // meshes que têm ARKit (para índices extra)

    // índices por mesh (arrays iguais ao número de exprMeshes)
    let idxBrowUp: number[] = [];
    let idxBrowDownL: number[] = [];
    let idxBrowDownR: number[] = [];
    let idxBlinkL: number[] = [];
    let idxBlinkR: number[] = [];
    let idxWideL: number[] = [];
    let idxWideR: number[] = [];
    let idxSmileL: number[] = [];
    let idxSmileR: number[] = [];

    let jawBone: THREE.Bone | null = null;
    const jawBoneCandidates = ["jaw", "Jaw", "JawBone", "mixamorig:Head", "Head"];

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // Esconder mãos & materiais
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

        // LOCALIZAR morphs (boca + expressões)
        mouthMeshes = [];
        mouthMorphIndices = [];
        exprMeshes = [];

        idxBrowUp = [];
        idxBrowDownL = [];
        idxBrowDownR = [];
        idxBlinkL = [];
        idxBlinkR = [];
        idxWideL = [];
        idxWideR = [];
        idxSmileL = [];
        idxSmileR = [];

        avatar.traverse((obj: any) => {
          const mesh = obj as MeshWithMorph;
          if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            // Boca
            const mouthIdx = findMorphIndex(mesh, mouthCandidates);
            if (mouthIdx >= 0) {
              mouthMeshes.push(mesh);
              mouthMorphIndices.push(mouthIdx);
            }

            // Expressões
            const bUp = findMorphIndex(mesh, browUpCandidates);
            const bDL = findMorphIndex(mesh, browDownLCandidates);
            const bDR = findMorphIndex(mesh, browDownRCandidates);
            const blL = findMorphIndex(mesh, eyeBlinkLCandidates);
            const blR = findMorphIndex(mesh, eyeBlinkRCandidates);
            const wL = findMorphIndex(mesh, eyeWideLCandidates);
            const wR = findMorphIndex(mesh, eyeWideRCandidates);
            const sL = findMorphIndex(mesh, smileLCandidates);
            const sR = findMorphIndex(mesh, smileRCandidates);

            if (
              bUp >= 0 || bDL >= 0 || bDR >= 0 ||
              blL >= 0 || blR >= 0 || wL >= 0 || wR >= 0 ||
              sL >= 0 || sR >= 0
            ) {
              exprMeshes.push(mesh);
              idxBrowUp.push(bUp);
              idxBrowDownL.push(bDL);
              idxBrowDownR.push(bDR);
              idxBlinkL.push(blL);
              idxBlinkR.push(blR);
              idxWideL.push(wL);
              idxWideR.push(wR);
              idxSmileL.push(sL);
              idxSmileR.push(sR);
            }
          }
        });

        // Fallback osso
        if (mouthMeshes.length === 0) {
          avatar.traverse((obj: any) => {
            if (obj.isBone) {
              const nm = (obj.name || "");
              if (jawBoneCandidates.some((c) => nm.includes(c))) {
                jawBone = obj;
              }
            }
          });
        }

        // Enquadrar
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.72,
          zoomFactor: 0.58,
        });

        // Ligar ao <audio id="alma-tts"> se não vier nível externo
        if (!audioLevelRef) connectToTTSAudio();
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
          yFocusBias: 0.72,
          zoomFactor: 0.58,
        });
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    // --- Animação / Expressões ---
    let raf = 0;
    let talkLevel = 0; // smoothed “fala”
    let blinkTimer = 0;
    let nextBlink = 0.8 + Math.random() * 3.0; // piscar a cada ~0.8–3.8s
    let blinkPhase = 0; // 0=open, 1=close, 2=open
    let headNod = 0; // pequeno abanar quando fala

    const tick = (t = 0) => {
      controls.update();

      // ======= áudio → nível 0..1 =======
      let openTarget = 0;
      if (audioLevelRef && typeof audioLevelRef.current === "number") {
        openTarget = Math.min(1, Math.max(0, audioLevelRef.current));
      } else if (analyser && dataArray) {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        // sensibilidade/base iguais à tua versão
        openTarget = Math.min(1, Math.max(0, (rms - 0.02) * 8));
      }

      // suavizar “está a falar?”
      talkLevel = lerp(talkLevel, openTarget, 0.3);

      // ======= LIPSYNC (igual base) =======
      if (mouthMeshes.length && mouthMorphIndices.length) {
        for (let i = 0; i < mouthMeshes.length; i++) {
          const m = mouthMeshes[i];
          const idx = mouthMorphIndices[i];
          if (m.morphTargetInfluences) {
            const current = m.morphTargetInfluences[idx] || 0;
            m.morphTargetInfluences[idx] = lerp(current, openTarget, 0.35);
          }
        }
      } else if (jawBone) {
        jawBone.rotation.x = -openTarget * 0.25;
      }

      // ======= MICRO-EXPRESSÕES (NOVO) =======
      // Intensidade global das expressões em função da fala
      const exprIntensity = talkLevel; // quando fala, ativa mais
      const idle = 0.02; // expressão mínima em repouso

      // Sobrancelhas: sobem ligeiro a falar, baixam um pouco no idle
      for (let i = 0; i < exprMeshes.length; i++) {
        const mesh = exprMeshes[i];
        const infl = mesh.morphTargetInfluences!;
        // brow up
        if (idxBrowUp[i] >= 0) {
          const curr = infl[idxBrowUp[i]] || 0;
          const target = idle * 0.2 + exprIntensity * 0.25;
          infl[idxBrowUp[i]] = lerp(curr, target, 0.15);
        }
        // brow down L/R
        if (idxBrowDownL[i] >= 0) {
          const curr = infl[idxBrowDownL[i]] || 0;
          const target = idle * 0.05 + (1 - exprIntensity) * 0.05;
          infl[idxBrowDownL[i]] = lerp(curr, target, 0.1);
        }
        if (idxBrowDownR[i] >= 0) {
          const curr = infl[idxBrowDownR[i]] || 0;
          const target = idle * 0.05 + (1 - exprIntensity) * 0.05;
          infl[idxBrowDownR[i]] = lerp(curr, target, 0.1);
        }
        // sorriso leve quando fala
        if (idxSmileL[i] >= 0) {
          const curr = infl[idxSmileL[i]] || 0;
          const target = idle * 0.05 + exprIntensity * 0.18;
          infl[idxSmileL[i]] = lerp(curr, target, 0.1);
        }
        if (idxSmileR[i] >= 0) {
          const curr = infl[idxSmileR[i]] || 0;
          const target = idle * 0.05 + exprIntensity * 0.18;
          infl[idxSmileR[i]] = lerp(curr, target, 0.1);
        }
      }

      // Piscar de olhos (independente, mas menos quando fala alto)
      const dt = 1 / 60;
      blinkTimer += dt;
      if (blinkTimer > nextBlink) {
        blinkTimer = 0;
        nextBlink = 0.8 + Math.random() * 3.0;
        blinkPhase = 1; // fechar
      }
      let blinkL = 0, blinkR = 0;
      if (blinkPhase === 1) {
        blinkL = blinkR = 1;
        // abre se estiver a falar alto (evita “piscar” em boca muito aberta)
        if (talkLevel > 0.4) blinkPhase = 2;
        else if (Math.random() < 0.15) blinkPhase = 2;
      } else if (blinkPhase === 2) {
        blinkL = blinkR = 0;
        blinkPhase = 0;
      }

      for (let i = 0; i < exprMeshes.length; i++) {
        const infl = exprMeshes[i].morphTargetInfluences!;
        if (idxBlinkL[i] >= 0) {
          const curr = infl[idxBlinkL[i]] || 0;
          infl[idxBlinkL[i]] = lerp(curr, blinkL, 0.35);
        }
        if (idxBlinkR[i] >= 0) {
          const curr = infl[idxBlinkR[i]] || 0;
          infl[idxBlinkR[i]] = lerp(curr, blinkR, 0.35);
        }
        // abrir olhos ligeiro quando fala (surpresa leve)
        if (idxWideL[i] >= 0) {
          const curr = infl[idxWideL[i]] || 0;
          infl[idxWideL[i]] = lerp(curr, Math.min(0.2, exprIntensity * 0.2), 0.08);
        }
        if (idxWideR[i] >= 0) {
          const curr = infl[idxWideR[i]] || 0;
          infl[idxWideR[i]] = lerp(curr, Math.min(0.2, exprIntensity * 0.2), 0.08);
        }
      }

      // Pequeno aceno de cabeça quando fala (muito subtil, só se tiver jawBone)
      if (jawBone) {
        headNod = lerp(headNod, exprIntensity * 0.06, 0.05);
        jawBone.rotation.y = Math.sin(t * 1.2) * headNod * 0.5;
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame((nt) => tick(nt / 1000));
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        if (mediaElSource) mediaElSource.disconnect();
        if (analyser) analyser.disconnect();
        if (zeroGain) zeroGain.disconnect();
        if (audioCtx) audioCtx.close();
      } catch {}
      el.removeChild(renderer.domElement);
      renderer.dispose();
      scene.traverse((obj: any) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    };
  }, [audioLevelRef]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
