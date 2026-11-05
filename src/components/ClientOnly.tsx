"use client";
import dynamic from "next/dynamic";
// three.js + WebGPU + a Web Worker: browser only, so skip server rendering for this part.
const SceneShift = dynamic(() => import("./SceneShift"), { ssr: false });
export default function ClientOnly() { return <SceneShift />; }
