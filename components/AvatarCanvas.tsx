"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const DEFAULT_URL =
  process.env.NEXT_PUBLIC_RPM_AVATAR_URL ||
  "https://models.readyplayer.me/68ac391e858e75812baf48c2.glb";

type Props = {
  url?: string;
  height?: number;
};

export default function AvatarCanvas({ url = DEFAULT_URL, height = 720 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current!;
    if (!container) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(container.clientWidth, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Scene & Camera
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(35, container.clientWidth / height, 0.1, 100);
    camera.position.set(0, 1.5, 2.8);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(5, 5, 5);
    scene.add(dir);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.target.set(0, 1.2, 0);
    controls.update();

    // Load GLB
    const loader = new GLTFLoader();
    let model: THREE.Object3D | null = null;

    loader.load(
      url,
      (gltf) => {
        model = gltf.scene;
        // posiciona suavemente o avatar
        model.position.set(0, -1.4, 0);
        scene.add(model);
      },
      undefined,
      (err) => {
        console.error("Falha ao carregar o GLB:", err);
      }
    );

    // Resize handler
    function onResize() {
      if (!container) return;
      const w = container.clientWidth;
      const h = height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    // Loop
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      renderer.render(scene, camera);
    };
    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (model) scene.remove(model);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [url, height]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height,
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #333",
        background: "#0b0b0b",
      }}
    />
  );
}
