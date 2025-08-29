"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

type Props = {
  /** Opcional: nível de áudio 0..1 vindo do page (se existir) */
  audioLevelRef?: React.RefObject<number>;
  /** Opcional: id do <audio> para o canvas auto-ligar o analyser (fallback) */
  audioElementId?: string; // por defeito "alma-tts"
};

/** Util: encontra índices de blendshapes relevantes num mesh com morph targets */
function findBlendshapeIndices(mesh: THREE.Mesh) {
  const dict = mesh.morphTargetDictionary || {};
  const idx = (name: string) =>
    typeof (dict as any)[name] === "number" ? (dict as any)[name] : -1;

  return {
    jawOpen: idx("jawOpen") !== -1 ? idx("jawOpen") : idx("MouthOpen"),
    // alguns RPM usam visemes
    viseme_aa: idx("viseme_aa"),
    viseme_A: idx("viseme_A"),
    // cantos dos lábios para um pouco de vida
    mouthSmile: idx("mouthSmile"),
    mouthFrown: idx("mouthFrown"),
  };
}

export default function AvatarCanvas({ audioLevelRef, audioElementId = "alma-tts" }: Props) {
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

    // Luzes simples
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.0);
    hemi.position.set(0, 2, 0);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(2, 4, 2);
    scene.add(dir);

    // Controlo de órbita
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Analyser (fallback interno)
    const audioCtxRef: { current: AudioContext | null } = { current: null };
    const analyserRef: { current: AnalyserNode | null } = { current: null };
    const srcNodeRef: { current: MediaElementAudioSourceNode | null } = { current: null };
    let levelInternal = 0;

    function attachAnalyserToAudio() {
      try {
        const elAudio = document.getElementById(audioElementId) as HTMLAudioElement | null;
        if (!elAudio) return;

        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
        }
        const ctx = audioCtxRef.current!;
        if (!analyserRef.current) {
          const src = ctx.createMediaElementSource(elAudio);
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          src.connect(an);
          // NÃO ligar a destination para não duplicar som no sistema
          analyserRef.current = an;
          srcNodeRef.current = src;
        }
      } catch {
        // ignora — não falhamos só por não ter analyser interno
      }
    }

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;

    // Guardar meshes com morphs
    const morphMeshes: { mesh: THREE.Mesh; idx: ReturnType<typeof findBlendshapeIndices> }[] = [];

    function collectMorphMeshes(root: THREE.Object3D) {
      morphMeshes.length = 0;
      root.traverse((o: any) => {
        const n = (o.name || "").toLowerCase();
        // esconder mãos (como já tinhas)
        if (n.includes("hand") || n.includes("wrist") || n.includes("wolf3d_hands")) {
          o.visible = false;
        }
        if (o.isMesh && o.morphTargetInfluences && o.morphTargetDictionary) {
          morphMeshes.push({ mesh: o, idx: findBlendshapeIndices(o) });
        }
      });
    }

    function fitCameraToObject(object: THREE.Object3D) {
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const padding = 0.95;
      const yFocusBias = 0.7;
      const zoomFactor = 0.6;

      const target = center.clone();
      target.y += size.y * (yFocusBias - 0.5);

      const fov = (camera.fov * Math.PI) / 180;
      const height = size.y * padding;
      const width = size.x * padding;
      const distForHeight = height / (2 * Math.tan(fov / 2));
      const distForWidth = width / (2 * Math.tan((fov * camera.aspect) / 2));
      let distance = Math.max(distForHeight, distForWidth);
      distance *= zoomFactor;

      const dirv = new THREE.Vector3(0, 0.12, 1).normalize();
      const newPos = target.clone().add(dirv.multiplyScalar(distance));

      camera.position.copy(newPos);
      camera.near = Math.max(0.01, distance / 100);
      camera.far = distance * 100;
      camera.updateProjectionMatrix();

      controls.target.copy(target);
      controls.update();

      renderer.render(object.parent as THREE.Scene, camera);
    }

    loader.load(
      AVATAR_URL,
      (gltf) => {
        avatar = gltf.scene;

        // normalizar altura ~1.75 m
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const desired = 1.75;
        const s = desired / (tmpSize.y || 1);
        avatar.scale.setScalar(s);

        scene.add(avatar);

        collectMorphMeshes(avatar);
        fitCameraToObject(avatar);

        // tentar ligar ao áudio do TTS se existir
        attachAnalyserToAudio();
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
      if (avatar) fitCameraToObject(avatar);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    // Loop
    let raf = 0;
    // smoothing simples para boca
    let smooth = 0;

    const tmpBuf = new Uint8Array(512);

    const tick = () => {
      // medir nível (prioridade: audioLevelRef; fallback: analyser interno)
      let lvl = 0;
      if (audioLevelRef && typeof audioLevelRef.current === "number") {
        lvl = Math.max(0, Math.min(1, audioLevelRef.current));
      } else if (analyserRef.current) {
        const an = analyserRef.current;
        const len = Math.min(tmpBuf.length, an.frequencyBinCount);
        an.getByteFrequencyData(tmpBuf);
        // média simples das baixas frequências (fala ~ < 1kHz)
        let sum = 0;
        const take = Math.max(8, Math.floor(len * 0.25));
        for (let i = 0; i < take; i++) sum += tmpBuf[i];
        lvl = (sum / (take * 255)) || 0;
      } else {
        // tentar ligar novamente (caso áudio só exista depois)
        attachAnalyserToAudio();
      }

      // suavizar
      const attack = 0.5; // mais responsivo a subir
      const release = 0.15; // cai devagar
      if (lvl > smooth) smooth = smooth * (1 - attack) + lvl * attack;
      else smooth = smooth * (1 - release) + lvl * release;

      // aplicar blendshapes
      if (morphMeshes.length) {
        const mouthOpen = Math.min(1, smooth * 1.3); // ganho
        const smile = Math.max(0, (smooth - 0.2) * 0.6);

        for (const { mesh, idx } of morphMeshes) {
          const infl = mesh.morphTargetInfluences!;
          if (idx.jawOpen !== -1) infl[idx.jawOpen] = mouthOpen;
          if (idx.viseme_aa !== -1) infl[idx.viseme_aa] = mouthOpen * 0.8;
          if (idx.viseme_A !== -1) infl[idx.viseme_A] = mouthOpen * 0.6;
          if (idx.mouthSmile !== -1) infl[idx.mouthSmile] = smile;
          if (idx.mouthFrown !== -1) infl[idx.mouthFrown] = 0;
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
      try { srcNodeRef.current?.disconnect(); } catch {}
      try { analyserRef.current?.disconnect?.(); } catch {}
      try { audioCtxRef.current?.close?.(); } catch {}
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
  }, [audioLevelRef, audioElementId]);

  // Altura generosa para aparecer bem centrado
  return <div ref={containerRef} style={{ width: "100%", height: "540px" }} />;
}
