export default async function jobRoutes(app, { jobs }) {
  app.get('/api/virtual-tryon/:jobId', async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({ error: 'Virtual try-on job not found.' });
    }
    return reply.send(job);
  });
}
