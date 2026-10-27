import { json } from '../http/respond';
import { jobProgress, runStep, setJobStatus, startJob } from '../jobs/runner';
import { ownedProject } from './access';
import type { Route } from './router';

export const jobRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/projects/:id/jobs',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const jobId = await startJob(env, user.id, params.id);
      return json({ jobId }, 201);
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/jobs/latest',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const job = await env.DB.prepare('SELECT id FROM jobs WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1').bind(params.id, user.id).first<{ id: string }>();
      return json(job ? await jobProgress(env, user.id, job.id) : { job: null });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/jobs/:jid/step',
    handler: async ({ env, user, params, fetch }) => {
      await ownedProject(env, user.id, params.id);
      return json(await runStep(env, user.id, params.jid, fetch));
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/jobs/:jid/resume',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      await setJobStatus(env, user.id, params.jid, 'running');
      return json(await jobProgress(env, user.id, params.jid));
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/jobs/:jid/cancel',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      await setJobStatus(env, user.id, params.jid, 'cancelled');
      return json(await jobProgress(env, user.id, params.jid));
    },
  },
];
