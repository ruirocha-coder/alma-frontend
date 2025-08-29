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

    // Audio analyser (fallback interno)
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let dataArray: Uint8Array | null = null;
    let mediaElSource: MediaElementAudioSourceNode | null = null;

    // Morph targets/bones
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
    let jawBone: THREE.Bone | null = null;
    const jawBoneCandidates = ["jaw", "Jaw", "JawBone", "mixamorig:Head", "Head"];

    // Load GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // Hide hands & tweak materials
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

        // Normalize scale ~1.75m
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);

        scene.add(avatar);

        // Find mouth morphs
        mouthMeshes = [];
        mouthMorphIndices = [];
        avatar.traverse((obj: any) => {
          const mesh = obj as MeshWithMorph;
          if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            for (const name of candidateMorphNames) {
              const idx = mesh.morphTargetDictionary[name];
              if (typeof idx === "number") {
                mouthMeshes.push(mesh);
                mouthMorphIndices.push(idx);
                break;
              }
            }
          }
        });

        // Bone fallback
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

        // Frame
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.72,
          zoomFactor: 0.58,
        });

        // Link to <audio id="alma-tts"> only if não vier nível externo
        if (!audioLevelRef) {
          connectToTTSAudio();
        }
      },
      undefined,
      (err) => console.error("Falha a carregar GLB:", err)
    );

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
        mediaElSource.connect(analyser);
        // não precisamos enviar o áudio para o destination (já toca pelo elemento <audio>)
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

      // Escolhe fonte de “abertura de boca”:
      // 1) se vier de audioLevelRef (Page), usa esse valor 0..1
      // 2) senão, calcula do analyser (rms)
      let open = 0;

      if (audioLevelRef && typeof audioLevelRef.current === "number") {
        open = Math.min(1, Math.max(0, audioLevelRef.current!));
      } else if (analyser && dataArray) {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length); // 0..~1
        open = Math.min(1, Math.max(0, (rms - 0.02) * 8));
      }

      if (mouthMeshes.length && mouthMorphIndices.length) {
        for (let i = 0; i < mouthMeshes.length; i++) {
          const m = mouthMeshes[i];
          const idx = mouthMorphIndices[i];
          if (m.morphTargetInfluences) m.morphTargetInfluences[idx] = open;
        }
      } else if (jawBone) {
        jawBone.rotation.x = -open * 0.25;
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
  }, [audioLevelRef]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
