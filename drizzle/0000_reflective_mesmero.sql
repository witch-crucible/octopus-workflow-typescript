CREATE TABLE "capy_integration_health" (
	"service" text PRIMARY KEY NOT NULL,
	"healthy" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"message" text NOT NULL,
	"checked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capy_octopus_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capy_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state_json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capy_requirements" (
	"requirement_id" text PRIMARY KEY NOT NULL,
	"parent_project_id" text NOT NULL,
	"requirement_name" text NOT NULL,
	"state_json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capy_workflow_events" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"run_id" text,
	"node_id" text,
	"type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capy_workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"requirement_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text NOT NULL,
	"forced" integer NOT NULL,
	"pid" integer,
	"current_action" integer,
	"started_at" text,
	"finished_at" text,
	"heartbeat_at" text,
	"exit_code" integer,
	"error" text,
	"stdout_path" text NOT NULL,
	"stderr_path" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capy_requirements" ADD CONSTRAINT "capy_requirements_parent_project_id_capy_projects_project_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."capy_projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capy_workflow_events" ADD CONSTRAINT "capy_workflow_events_requirement_id_capy_requirements_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."capy_requirements"("requirement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capy_workflow_runs" ADD CONSTRAINT "capy_workflow_runs_requirement_id_capy_requirements_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."capy_requirements"("requirement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capy_projects_updated_at_idx" ON "capy_projects" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "capy_requirements_project_idx" ON "capy_requirements" USING btree ("parent_project_id","updated_at");--> statement-breakpoint
CREATE INDEX "capy_workflow_events_requirement_idx" ON "capy_workflow_events" USING btree ("requirement_id","sequence");--> statement-breakpoint
CREATE INDEX "capy_workflow_runs_requirement_idx" ON "capy_workflow_runs" USING btree ("requirement_id","node_id","started_at");
--> statement-breakpoint
INSERT INTO "capy_octopus_meta" ("key", "value") VALUES ('schema_version', '2')
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value";
--> statement-breakpoint
ALTER TABLE "capy_octopus_meta" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capy_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capy_requirements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capy_workflow_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capy_workflow_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "capy_integration_health" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "capy_octopus_meta", "capy_projects", "capy_requirements",
      "capy_workflow_runs", "capy_workflow_events", "capy_integration_health" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "capy_octopus_meta", "capy_projects", "capy_requirements",
      "capy_workflow_runs", "capy_workflow_events", "capy_integration_health" FROM authenticated;
  END IF;
END $$;
