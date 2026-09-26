CREATE TABLE IF NOT EXISTS task_applications (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  note text CHECK (note IS NULL OR length(note) <= 500),
  status text NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','SELECTED','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, worker_id)
);

CREATE INDEX IF NOT EXISTS task_applications_task_status_idx
  ON task_applications(task_id, status, created_at ASC);
CREATE INDEX IF NOT EXISTS task_applications_worker_idx
  ON task_applications(worker_id, created_at DESC);

DROP TRIGGER IF EXISTS task_applications_touch_updated_at ON task_applications;
CREATE TRIGGER task_applications_touch_updated_at
  BEFORE UPDATE ON task_applications
  FOR EACH ROW EXECUTE FUNCTION groundwork_touch_updated_at();
