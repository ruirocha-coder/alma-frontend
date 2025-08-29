"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
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

/** Procura o índice de um morph target por uma lista de nomes possíveis. */
function findMorphIndex(
  dict: { [name: string]: number } | undefined,
  candidates: string[]
) {
  if (!dict) return -1;
  const keys = Object.keys(dict);
  // procura case-insensitive e com underscores/maiúsculas variações
  for (const candRaw of candidates) {
    const cand = candRaw.toLowerCase();
    const hit = keys.find((k) => k.toLowerCase() === cand || k.toLowerCase().includes(cand));
    if (hit) return dict[hit];
  }
  return -1;
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
    scene.add(dir);

    // Controlo de órbita (limitado)
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    const loader = new GLTFLoader();

    // WebAudio p/ lipsync
    let audioCtx: AudioContext | null = null;
    let srcNode: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    const fftSize = 2048;
    let dataArray: Uint8Array | null = null;

    // morph targets
    let headMesh: THREE.Mesh | null = null;
    let dict: any = null;
    let infl: number[] | undefined;

    let idxJawOpen = -1;
    let idxMouthOpen = -1;
    let idxVisAA = -1;
    let idxVisE = -1;
    let idxVisO = -1;
    let idxVisU = -1;
    let idxVisFV = -1;
    let idxVisPP = -1;

    // suavisadores
    let env = 0; // envelope de volume 0..1
    const attack = 0.25;  // mais rápido a abrir
    const release = 0.08; // fecha mais devagar

    // cria/actualiza ligação ao <audio id="alma-tts">
    function attachAudio() {
      const elAudio = document.getElementById("alma-tts") as HTMLAudioElement | null;
      if (!elAudio) return;

      if (!audioCtx) {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") {
        // vai ser retomado no primeiro play
        const resumeOnce = () => {
          audioCtx!.resume().catch(() => {});
          elAudio.removeEventListener("play", resumeOnce);
        };
        elAudio.addEventListener("play", resumeOnce);
      }

      if (!srcNode) {
        try {
          srcNode = audioCtx.createMediaElementSource(elAudio);
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = fftSize;
          analyser.smoothingTimeConstant = 0.85;
          dataArray = new Uint8Array(analyser.frequencyBinCount);
          srcNode.connect(analyser);
          analyser.connect(audioCtx.destination); // opcional: enviar para saída. Se notares eco, remove.
        } catch (e) {
          // já estava ligado? ignora
        }
      }
    }

    // Carregar GLB
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

        // Encontrar a malha da cabeça com morphs
        avatar.traverse((o: any) => {
          if (o.isMesh && o.morphTargetInfluences && o.morphTargetDictionary) {
            // Heurística: a cabeça costuma ter muitos morphs e chama-se "Wolf3D_Head" ou semelhante.
            if (!headMesh || Object.keys(o.morphTargetDictionary).length > 10) {
              headMesh = o as THREE.Mesh;
            }
          }
        });

        if (headMesh) {
          dict = (headMesh as any).morphTargetDictionary;
          infl = (headMesh as any).morphTargetInfluences;

          // Índices mais usados (ARKit / RPM)
          idxJawOpen = findMorphIndex(dict, ["jawOpen", "jaw_open"]);
          idxMouthOpen = findMorphIndex(dict, ["mouthOpen", "mouth_open"]);
          // Visemes comuns no RPM
          idxVisAA = findMorphIndex(dict, ["viseme_aa", "aa", "A"]);
          idxVisE = findMorphIndex(dict, ["viseme_e", "E"]);
          idxVisO = findMorphIndex(dict, ["viseme_oh", "viseme_o", "O"]);
          idxVisU = findMorphIndex(dict, ["viseme_uh", "viseme_u", "U"]);
          idxVisFV = findMorphIndex(dict, ["viseme_FV", "viseme_fv", "fv"]);
          idxVisPP = findMorphIndex(dict, ["viseme_PP", "viseme_pp", "pp"]);
        }

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
          padding: 0.95,
          yFocusBias: 0.7,
          zoomFactor: 0.6,
        });

        // Tentar ligar ao áudio assim que o modelo carrega
        attachAudio();
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

    // Re-tentar ligação ao áudio se o elemento aparecer depois
    const audioRetryIv = setInterval(() => attachAudio(), 1000);

    // Loop
    let raf = 0;
    const tick = () => {
      controls.update();

      // Lipsync
      if (analyser && dataArray && headMesh && infl) {
        analyser.getByteTimeDomainData(dataArray);
        // RMS simples
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128; // -1..1
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length); // 0..~1

        // envelope com attack/release
        const target = Math.min(1, Math.max(0, (rms - 0.02) * 4.0)); // gate + ganho
        env = env < target ? env + (target - env) * attack : env + (target - env) * release;

        // mapear env para morphs
        const jaw = Math.min(1, env * 1.4);
        const mouth = Math.min(1, env * 1.2);

        // limpa visemes menores
        const setInfl = (idx: number, val: number) => {
          if (idx >= 0) infl![idx] = val;
        };

        // distribuição simples pelos visemes
        setInfl(idxJawOpen, jaw);
        setInfl(idxMouthOpen, mouth);

        // Sugerir um “shape” vocal com base em bandas (muito simples)
        // Podes evoluir isto com FFT real e pesos de banda.
        const vAA = Math.min(1, env * 1.1);
        const vE = Math.max(0, env * 0.6 - 0.1);
        const vO = Math.max(0, env * 0.8 - 0.05);
        const vU = Math.max(0, env * 0.7 - 0.1);
        const vFV = Math.max(0, env * 0.5 - 0.2);
        const vPP = Math.max(0, env * 1.2 - 0.7); // plosivas só em picos

        setInfl(idxVisAA, vAA);
        setInfl(idxVisE, vE);
        setInfl(idxVisO, vO);
        setInfl(idxVisU, vU);
        setInfl(idxVisFV, vFV);
        setInfl(idxVisPP, vPP);
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(audioRetryIv);
      ro.disconnect();
      try { srcNode?.disconnect(); } catch {}
      try { analyser?.disconnect(); } catch {}
      try { audioCtx?.close(); } catch {}
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

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
      }}
    />
  );
}
