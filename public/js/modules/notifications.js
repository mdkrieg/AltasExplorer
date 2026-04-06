/**
 * Notifications module.
 * Owns notification badge rendering and notifications modal/grid behavior.
 */

import * as panels from './panels.js';
import { w2ui } from './vendor/w2ui.es6.min.js';

export function updateNotificationBadge() {
  const $badge = $('#notifications-badge');
  if (panels.unreadNotificationCount > 0) {
    $badge.text(panels.unreadNotificationCount > 99 ? '99+' : panels.unreadNotificationCount).show();
  } else {
    $badge.hide();
  }
}

export async function showNotificationsModal() {
  $('#notifications-modal').css('display', 'flex');
  await loadNotifications();
}

export async function hideNotificationsModal() {
  $('#notifications-modal').hide();
  if (w2ui['notifications-grid']) {
    w2ui['notifications-grid'].destroy();
  }
  await window.electronAPI.markAllNotificationsRead();
  panels.resetNotificationCount();
  updateNotificationBadge();
}

export async function markAllNotificationsRead() {
  await window.electronAPI.markAllNotificationsRead();
  panels.resetNotificationCount();
  updateNotificationBadge();
  await loadNotifications();
}

export async function loadNotifications() {
  const result = await window.electronAPI.getNotifications();
  if (!result.success) {
    console.error('Error loading notifications:', result.error);
    return;
  }

  if (w2ui['notifications-grid']) {
    w2ui['notifications-grid'].destroy();
  }

  const records = (result.data || []).map((notification, index) => ({
    recid: index + 1,
    detectedAt: notification.created_at ? new Date(notification.created_at).toLocaleString() : '—',
    filename: notification.filename || '—',
    category: notification.category || '—',
    oldValue: notification.old_value ? (notification.old_value.substring(0, 12) + '...') : '—',
    newValue: notification.new_value ? (notification.new_value.substring(0, 12) + '...') : '—',
    isRead: notification.read_at !== null
  }));

  $('#notifications-grid').w2grid({
    name: 'notifications-grid',
    style: 'width: 100%; height: 100%;',
    show: { header: false, toolbar: false, footer: true },
    columns: [
      { field: 'detectedAt', text: 'Date', size: '160px', resizable: true, sortable: true },
      { field: 'filename', text: 'File', size: '30%', resizable: true, sortable: true },
      { field: 'category', text: 'Category', size: '15%', resizable: true, sortable: true },
      { field: 'oldValue', text: 'Old Checksum', size: '130px', resizable: true },
      { field: 'newValue', text: 'New Checksum', size: '130px', resizable: true }
    ],
    records,
    onLoad: function (event) {
      event.preventDefault();
    }
  });

  $('#notifications-grid').w2render('notifications-grid');
}