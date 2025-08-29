"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const AVATAR_URL =
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

type Props = {
  audioLevelRef?: React.MutableRefObject<number>; // 0..1
};

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  controls: OrbitControls,
  renderer: THREE.WebGLRenderer,
  { padding = 1.0, yFocusBias = 0.5, zoomFactor = 0.7 }: { padding?: number; yFocusBias?: number; zoomFactor?: number }
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
    let clock = new THREE.Clock();

    // LIPSYNC targets
    let jawBone: THREE.Bone | null = null;
    const morphTargets: { mesh: THREE.Mesh; index: number }[] = [];

    function collectLipTargets(root: THREE.Object3D) {
      root.traverse((o: any) => {
        // procurar ‘jaw’ bone
        if (o.isBone && typeof o.name === "string") {
          const n = o.name.toLowerCase();
          if (n.includes("jaw")) jawBone = o;
        }
        // morph targets
        if (o.isMesh && o.morphTargetDictionary && o.morphTargetInfluences) {
          const dict = o.morphTargetDictionary as Record<string, number>;
          const names = Object.keys(dict);
          // comuns: jawOpen, mouthOpen, viseme_*
          const candidatas = names.filter(
            (k) =>
              /jawopen|mouthopen|viseme_/i.test(k) ||
              /mouth/i.test(k)
          );
          candidatas.forEach((name) => {
            morphTargets.push({ mesh: o, index: dict[name] });
          });
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

        // Mixer se houver animações
        if (gltf.animations && gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(avatar);
          const action = mixer.clipAction(gltf.animations[0]);
          action.play();
        }

        // recolher targets de boca
        collectLipTargets(avatar);
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

      // LIPSYNC: aplicar nível (0..1) → boca
      const lvl = audioLevelRef?.current ?? 0;
      const open = Math.min(1, lvl * 1.2); // leve ganho

      if (morphTargets.length > 0) {
        for (const { mesh, index } of morphTargets) {
          if (mesh.morphTargetInfluences) {
            mesh.morphTargetInfluences[index] = open;
          }
        }
      } else if (jawBone) {
        // rodar a mandíbula um pouco
        jawBone.rotation.x = open * 0.25; // ~14°
      } // senão, nada (avatar sem rig de boca)

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
