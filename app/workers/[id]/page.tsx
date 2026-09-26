import { WorkerExperienceShell } from "../../components/experience-client-shells";

export default async function WorkerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkerExperienceShell workerId={id} />;
}
