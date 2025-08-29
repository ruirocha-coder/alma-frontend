"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_GLTF_URL ||
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  // TIP: acrescenta ?morphTargets=ARKit no teu URL real
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

export default function AvatarCanvas() {
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

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    hemi.position.set(0, 2, 0);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 4, 2);
    scene.add(dir);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Audio Analyser (para lipsync por amplitude)
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let dataArray: Uint8Array | null = null;
    let mediaElSource: MediaElementAudioSourceNode | null = null;

    // Meshes/bones para lipsync
    const candidateMorphNames = [
      "jawOpen",
      "mouthOpen",
      "viseme_aa",
      "MouthOpen",
      "mouthOpen_BS",
      "CC_Base_BlendShape.MouthOpen",
      "Wolf3D_Avatar.MouthOpen",
    ];

    let mouthMeshes: MeshWithMorph[] = [];
    let mouthMorphIndices: number[] = [];

    // fallback se não houver morphs: tenta rodar mandíbula
    let jawBone: THREE.Bone | null = null;
    const jawBoneCandidates = ["jaw", "Jaw", "JawBone", "mixamorig:Head", "Head"]; // heurístico

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;

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

        // Normalizar escala
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);

        scene.add(avatar);

        // Procurar morphs de boca
        mouthMeshes = [];
        mouthMorphIndices = [];
        avatar.traverse((obj: any) => {
          const mesh = obj as MeshWithMorph;
          if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            // tenta encontrar o primeiro morph que bata com os nomes candidatos
            for (const name of candidateMorphNames) {
              const idx = mesh.morphTargetDictionary[name];
              if (typeof idx === "number") {
                mouthMeshes.push(mesh);
                mouthMorphIndices.push(idx);
                break; // usa o primeiro que existir neste mesh
              }
            }
          }
        });

        // se não houver morphs, tenta encontrar um osso de mandíbula para pequeno movimento
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

        // Ligar ao áudio do TTS
        connectToTTSAudio();
      },
      undefined,
      (err) => console.error("Falha a carregar GLB:", err)
    );

    function connectToTTSAudio() {
      const elAudio = document.getElementById("alma-tts") as HTMLAudioElement | null;
      if (!elAudio) {
        // tenta mais tarde (quando o Page criar o <audio>)
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
        mediaElSource.connect(analyser);
        analyser.connect(audioCtx.destination); // opcional (para “ouvir” via contexto)
      } catch (e) {
        console.warn("Não consegui ligar Analyser ao audio do TTS:", e);
      }
    }

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

    // Loop
    let raf = 0;
    const tick = () => {
      controls.update();

      // Lipsync simples por amplitude
      if (analyser && dataArray) {
        analyser.getByteTimeDomainData(dataArray);
        // RMS rápido
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128; // [-1..1]
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length); // 0..~1
        // normalizar e comprimir um bocado
        let open = Math.min(1, Math.max(0, (rms - 0.02) * 8));

        if (mouthMeshes.length && mouthMorphIndices.length) {
          for (let i = 0; i < mouthMeshes.length; i++) {
            const m = mouthMeshes[i];
            const idx = mouthMorphIndices[i];
            if (m.morphTargetInfluences) {
              m.morphTargetInfluences[idx] = open;
            }
          }
        } else if (jawBone) {
          // fallback: roda ligeiramente a mandíbula
          jawBone.rotation.x = -open * 0.25; // ~14º
        }
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        if (mediaElSource) mediaElSource.disconnect();
        if (analyser) analyser.disconnect();
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
  }, []);

  // Ocupa toda a altura disponível do “slot” do container no Page
  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
