"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

type Props = {
  /** 0..1 (vem do page.tsx via WebAudio analyser do <audio> TTS) */
  audioLevelRef?: React.MutableRefObject<number>;
};

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

/** Estruturas para *lipsync* */
type MorphTargetRef = { mesh: THREE.Mesh; index: number; name: string };
type LipRig = {
  openPrimary?: MorphTargetRef;   // jawOpen/mouthOpen/viseme_*
  openSecondary?: MorphTargetRef; // viseme secundário, opcional
  mouthClose?: MorphTargetRef;    // se existir, animamos ao inverso
  jawBone?: THREE.Bone;           // fallback: rodar mandíbula
};

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

    // Controlo
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minPolarAngle = Math.PI * 0.15;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 0.6;
    controls.maxDistance = 4.0;

    // Carregar GLB
    const loader = new GLTFLoader();
    let avatar: THREE.Group | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const clock = new THREE.Clock();

    // Lip rig encontrado no modelo
    const lipRig: LipRig = {};
    // nível suavizado para abrir/fechar de forma natural
    let smoothOpen = 0;

    function nameMatch(n: string, ...needles: string[]) {
      const L = n.toLowerCase();
      return needles.some((k) => L.includes(k));
    }

    function collectLipTargets(root: THREE.Object3D) {
      root.traverse((o: any) => {
        // osso da mandíbula
        if (o.isBone && typeof o.name === "string") {
          const n = o.name.toLowerCase();
          if (!lipRig.jawBone && nameMatch(n, "jaw", "lowerjaw", "mandible", "chin")) {
            lipRig.jawBone = o as THREE.Bone;
          }
        }

        // morphs
        if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) {
          const dict = o.morphTargetDictionary as Record<string, number>;
          const addIf = (preds: RegExp[] | string[], assign: (ref: MorphTargetRef) => void) => {
            for (const key of Object.keys(dict)) {
              const low = key.toLowerCase();
              const ok = Array.isArray(preds)
                ? (preds as any).some((p: any) => (p.test ? p.test(low) : low.includes(p)))
                : (low.includes(preds as any));
              if (ok) {
                assign({ mesh: o, index: dict[key], name: key });
                return true;
              }
            }
            return false;
          };

          // prioridade para abrir boca
          // 1) jawOpen
          if (!lipRig.openPrimary) {
            addIf(["jawopen"], (ref) => (lipRig.openPrimary = ref));
          }
          // 2) mouthOpen
          if (!lipRig.openPrimary) {
            addIf(["mouthopen"], (ref) => (lipRig.openPrimary = ref));
          }
          // 3) visemes típicos (aa, oh) — muitos RPM exportam
          if (!lipRig.openPrimary) {
            addIf([/viseme_aa/, /viseme_oh/], (ref) => (lipRig.openPrimary = ref));
          }
          // secundário para variação (ih/ee) se existir
          if (!lipRig.openSecondary) {
            addIf([/viseme_ih/, /viseme_ee/, /viseme_ao/, /viseme_uw/], (ref) => (lipRig.openSecondary = ref));
          }
          // fechar boca (inverso)
          if (!lipRig.mouthClose) {
            addIf(["mouthclose", "lipsclosed"], (ref) => (lipRig.mouthClose = ref));
          }
        }
      });
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

        // Normalizar altura
        const tmpBox = new THREE.Box3().setFromObject(avatar);
        const tmpSize = new THREE.Vector3();
        tmpBox.getSize(tmpSize);
        const heightM = tmpSize.y || 1;
        const desired = 1.75;
        avatar.scale.setScalar(desired / heightM);
        scene.add(avatar);

        // Enquadrar
        fitCameraToObject(camera, avatar, controls, renderer, {
          padding: 0.95,
          yFocusBias: 0.7,
          zoomFactor: 0.6,
        });

        // Animações (se houver idle)
        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(avatar);
          const action = mixer.clipAction(gltf.animations[0]);
          action.play();
        }

        // recolher rig de boca
        collectLipTargets(avatar);
        // feedback no console para sabermos o que apanhou
        // console.log("LipRig:", {
        //   openPrimary: lipRig.openPrimary?.name,
        //   openSecondary: lipRig.openSecondary?.name,
        //   mouthClose: lipRig.mouthClose?.name,
        //   jawBone: lipRig.jawBone?.name,
        // });
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
    const tick = () => {
      const dt = clock.getDelta();
      if (mixer) mixer.update(dt);

      // ---- LIPSYNC ----
      // alvo atual (0..1) vindo do nível de áudio
      const inLvl = Math.max(0, Math.min(1, audioLevelRef?.current ?? 0));

      // curva: mais abertura com pouco som (gamma < 1), e ganho extra
      const gamma = 0.7;
      const gain = 1.8;
      const targetOpen = Math.max(0, Math.min(1, Math.pow(inLvl, gamma) * gain));

      // smoothing (ataque rápido, *release* mais lento para não “trémulo”)
      const attack = 0.35;  // quanto maior, mais responde rápido a abrir
      const release = 0.12; // quanto maior, mais rápido a fechar
      const k = targetOpen > smoothOpen ? attack : release;
      smoothOpen = smoothOpen + (targetOpen - smoothOpen) * k;

      // limiar para não “mexer só os lábios”
      const open = smoothOpen < 0.06 ? 0 : smoothOpen;

      // aplicar a morph targets, se existirem
      if (lipRig.openPrimary && lipRig.openPrimary.mesh.morphTargetInfluences) {
        lipRig.openPrimary.mesh.morphTargetInfluences[lipRig.openPrimary.index] = open;
      }
      if (lipRig.openSecondary && lipRig.openSecondary.mesh.morphTargetInfluences) {
        lipRig.openSecondary.mesh.morphTargetInfluences[lipRig.openSecondary.index] = open * 0.5;
      }
      if (lipRig.mouthClose && lipRig.mouthClose.mesh.morphTargetInfluences) {
        // fechar ao inverso
        lipRig.mouthClose.mesh.morphTargetInfluences[lipRig.mouthClose.index] = 1 - open;
      }

      // fallback: rodar mandíbula se não houver morphs
      if (!lipRig.openPrimary && !lipRig.openSecondary && lipRig.jawBone) {
        lipRig.jawBone.rotation.x = open * 0.35; // ~20°
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
