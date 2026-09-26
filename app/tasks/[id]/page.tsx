import { TaskExperienceShell } from "../../components/experience-client-shells";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskExperienceShell taskId={id} />;
}
