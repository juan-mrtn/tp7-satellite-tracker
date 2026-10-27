import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Pass } from '../core/orbital/types';
import {
  planReminders,
  reminderContent,
  reminderId,
  reminderPrefixFor,
  REMINDER_PREFIX,
  type PlannedReminder,
} from './passReminders';

export const CHANNEL_ID = 'passes';
/** iOS admite 64 notificaciones locales pendientes en total: se deja margen. */
export const MAX_PENDING = 60;

/** Debe llamarse al iniciar la app: define cómo se muestran las notificaciones y crea el canal. */
export async function initNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Pases de satélites',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const res = await Notifications.requestPermissionsAsync();
  return res.granted;
}

async function pendingIds(): Promise<string[]> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.map((n) => n.identifier).filter((id) => id.startsWith(REMINDER_PREFIX));
}

async function scheduleOne(r: PlannedReminder): Promise<void> {
  const { title, body } = reminderContent(r);
  await Notifications.scheduleNotificationAsync({
    identifier: r.id,
    content: {
      title,
      body,
      sound: true,
      data: { noradId: r.noradId, aos: r.pass.aos.getTime(), los: r.pass.los.getTime() },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.fireAt, channelId: CHANNEL_ID },
  });
}

/** Cancela todos los recordatorios de un satélite. */
export async function cancelRemindersFor(noradId: number): Promise<void> {
  const prefix = reminderPrefixFor(noradId);
  const ids = (await pendingIds()).filter((id) => id.startsWith(prefix));
  await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
}

/**
 * Reemplaza los recordatorios de un satélite por los de `passes` (modo "seguir satélite").
 * Devuelve cuántos quedaron agendados.
 */
export async function replaceRemindersFor(
  noradId: number,
  satelliteName: string,
  passes: readonly Pass[],
  minutesBefore: number,
  now = Date.now()
): Promise<number> {
  await cancelRemindersFor(noradId);
  const others = (await pendingIds()).length;
  const plan = planReminders(passes, {
    noradId,
    satelliteName,
    minutesBefore,
    now,
    maxCount: Math.max(0, MAX_PENDING - others),
  });
  for (const r of plan) await scheduleOne(r);
  return plan.length;
}

/** Agenda o cancela el recordatorio de UN pase (campana de la lista). Devuelve el estado final. */
export async function togglePassReminder(
  noradId: number,
  satelliteName: string,
  pass: Pass,
  minutesBefore: number,
  now = Date.now()
): Promise<boolean> {
  const id = reminderId(noradId, pass.aos.getTime());
  if ((await pendingIds()).includes(id)) {
    await Notifications.cancelScheduledNotificationAsync(id);
    return false;
  }
  if ((await pendingIds()).length >= MAX_PENDING) return false;
  const [plan] = planReminders([pass], { noradId, satelliteName, minutesBefore, now, maxCount: 1 });
  if (!plan) return false;
  await scheduleOne(plan);
  return true;
}

export async function scheduledPassIds(): Promise<Set<string>> {
  return new Set(await pendingIds());
}

export { reminderId };
