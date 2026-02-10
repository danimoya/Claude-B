import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NotificationInbox } from '../../notifications/inbox.js';

interface NotificationParams {
  id: string;
}

interface ListNotificationsQuery {
  unread?: string;
  limit?: string;
}

export async function registerNotificationRoutes(
  app: FastifyInstance,
  inbox: NotificationInbox
): Promise<void> {

  // List notifications
  app.get('/api/notifications', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Querystring: ListNotificationsQuery }>) => {
    const unreadOnly = request.query.unread === 'true';
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
    const notifications = unreadOnly
      ? await inbox.getUnread()
      : await inbox.getAll(limit);
    return { notifications };
  });

  // Get notification counts
  app.get('/api/notifications/count', {
    preHandler: [app.authenticate]
  }, async () => {
    return await inbox.count();
  });

  // Mark one notification as read
  app.post<{ Params: NotificationParams }>('/api/notifications/:id/read', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: NotificationParams }>, reply: FastifyReply) => {
    const marked = await inbox.markRead(request.params.id);
    if (!marked) {
      return reply.status(404).send({ error: 'Notification not found or already read' });
    }
    return { success: true };
  });

  // Delete one notification
  app.delete<{ Params: NotificationParams }>('/api/notifications/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: NotificationParams }>, reply: FastifyReply) => {
    const deleted = await inbox.deleteNotification(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Notification not found' });
    }
    return { success: true };
  });

  // Mark all as read
  app.post('/api/notifications/read-all', {
    preHandler: [app.authenticate]
  }, async () => {
    const cleared = await inbox.markAllRead();
    return { success: true, cleared };
  });
}
