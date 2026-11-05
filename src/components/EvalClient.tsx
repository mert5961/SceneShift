"use client";
import dynamic from "next/dynamic";
const Eval = dynamic(() => import("./Eval"), { ssr: false });
export default function EvalClient() { return <Eval />; }
