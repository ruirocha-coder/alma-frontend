"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type AvatarCanvasProps = { audioLevelRef?: React.RefObject<number> };

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

export default function AvatarCanvas(_props: AvatarCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // refs para lipsync
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rmsRef = useRef(0); // nível suavizado 0..1

  // target do blendshape
  const jawTargetsRef = useRef<
    { mesh: THREE.Mesh; index: number }[]
  >([]);

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

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // Esconder mãos (nomes comuns em ReadyPlayerMe)
        avatar.traverse((o: any) => {
          const n = (o.name || "").toLowerCase();
          if (
            n.includes("hand") || // LeftHand / RightHand / mixamorig:RightHand
            n.includes("wrist") || // Wrist joints
            n.includes("wolf3d_hands") // alguns RPM exportam meshes com este nome
          ) {
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

        // Normalizar escala para ~1.75m de altura
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);

        scene.add(avatar);

        // Procurar blendshapes / morph targets de boca
        jawTargetsRef.current = [];
        avatar.traverse((obj: any) => {
          if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetInfluences) {
            const dict = obj.morphTargetDictionary as Record<string, number>;
            // chaves comuns RPM/ARKit: "jawOpen", "mouthOpen"
            const keys = Object.keys(dict);
            const findKey = (needle: string) =>
              keys.find((k) => k.toLowerCase().includes(needle));
            const mouthKey =
              findKey("jawopen") ||
              findKey("mouthopen") ||
              findKey("jaw_open") ||
              findKey("mouth_open");
            if (mouthKey) {
              const idx = dict[mouthKey];
              if (typeof idx === "number") {
                jawTargetsRef.current.push({ mesh: obj as THREE.Mesh, index: idx });
              }
            }
          }
        });

        // Enquadrar mais próximo e focado na cabeça
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95, // pouca margem
          yFocusBias: 0.7, // foca bem alto (cabeça)
          zoomFactor: 0.6, // aproxima
        });
      },
      undefined,
      (err) => console.error("Falha a carregar GLB:", err)
    );

    // Ligação ao <audio id="alma-tts"> para lipsync
    function connectToAlmaAudio() {
      const elAudio = document.getElementById("alma-tts") as HTMLAudioElement | null;
      if (!elAudio) return;

      // cria/reutiliza AudioContext
      let ctx = audioCtxRef.current;
      if (!ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        ctx = new AC();
        audioCtxRef.current = ctx;
      }

      // resume em iOS no gesto
      const resume = () => {
        ctx!.resume?.();
        document.removeEventListener("touchstart", resume);
        document.removeEventListener("click", resume);
      };
      document.addEventListener("touchstart", resume, { once: true });
      document.addEventListener("click", resume, { once: true });

      // criar nó de origem a partir do elemento <audio>
      if (!srcNodeRef.current) {
        srcNodeRef.current = ctx.createMediaElementSource(elAudio);
      }
      // analyser
      if (!analyserRef.current) {
        const a = ctx.createAnalyser();
        a.fftSize = 2048;
        a.smoothingTimeConstant = 0.8;
        analyserRef.current = a;
      }

      // pipeline: element -> analyser -> destination
      try {
        srcNodeRef.current.disconnect();
      } catch {}
      srcNodeRef.current.connect(analyserRef.current!);
      analyserRef.current!.connect(ctx.destination);
    }

    // tentar ligar já e também quando o áudio fizer play
    connectToAlmaAudio();
    const onAudioPlayTryConnect = () => connectToAlmaAudio();
    document.addEventListener("play", onAudioPlayTryConnect, true);

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
    const timeLerp = (from: number, to: number, t: number) => from + (to - from) * t;
    const freq = new Uint8Array(256);

    const tick = () => {
      // lipsync: calcular RMS simples do espectro → suavizar → mapear 0..1
      if (analyserRef.current && jawTargetsRef.current.length > 0) {
        analyserRef.current.getByteFrequencyData(freq);
        let sum = 0;
        for (let i = 0; i < freq.length; i++) {
          const v = freq[i] / 255; // 0..1
          sum += v * v;
        }
        const rms = Math.sqrt(sum / freq.length); // 0..1
        // compressão suave para abrir mais a boca com volumes moderados
        const target = Math.min(1, Math.max(0, (rms - 0.05) * 2.5));
        // suavização temporal (menos “tremeliques”)
        rmsRef.current = timeLerp(rmsRef.current, target, 0.2);

        // aplicar em todas as malhas que tenham o morph
        const open = rmsRef.current;
        for (const { mesh, index } of jawTargetsRef.current) {
          if (mesh.morphTargetInfluences) {
            mesh.morphTargetInfluences[index] = open;
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
      document.removeEventListener("play", onAudioPlayTryConnect, true);

      // desligar audio graph
      try {
        analyserRef.current?.disconnect();
      } catch {}
      try {
        srcNodeRef.current?.disconnect();
      } catch {}
      analyserRef.current = null;
      srcNodeRef.current = null;
      // não fechamos o AudioContext para poder ser reutilizado

      // three cleanup
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

  // container ocupa o espaço que o pai der
  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
