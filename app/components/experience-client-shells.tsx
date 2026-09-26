"use client";

import dynamic from "next/dynamic";
import { LoadingState } from "./ui";

function loading(label: string) {
  return <main className="page-shell"><LoadingState label={label} /></main>;
}

const Marketplace = dynamic(() => import("./experience-pages").then((module) => module.MarketplacePage), {
  ssr: false,
  loading: () => loading("Loading task listings…"),
});
const Task = dynamic(() => import("./experience-pages").then((module) => module.TaskPage), {
  ssr: false,
  loading: () => loading("Loading task details…"),
});
const Work = dynamic(() => import("./experience-pages").then((module) => module.WorkPage), {
  ssr: false,
  loading: () => loading("Loading your work…"),
});
const Worker = dynamic(() => import("./experience-pages").then((module) => module.WorkerPage), {
  ssr: false,
  loading: () => loading("Loading worker profile…"),
});
const Agents = dynamic(() => import("./experience-pages").then((module) => module.AgentsPage), {
  ssr: false,
  loading: () => loading("Loading owner workspace…"),
});

export function MarketplaceExperienceShell() { return <Marketplace />; }
export function TaskExperienceShell({ taskId }: { taskId: string }) { return <Task taskId={taskId} />; }
export function WorkExperienceShell() { return <Work />; }
export function WorkerExperienceShell({ workerId }: { workerId: string }) { return <Worker workerId={workerId} />; }
export function AgentsExperienceShell() { return <Agents />; }
