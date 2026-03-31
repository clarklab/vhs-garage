const SETTINGS_KEY = 'vhsg_capture_settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  const existing = loadSettings();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, ...settings }));
}

export async function requestPermissions() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  stream.getTracks().forEach(t => t.stop());
}

export async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    video: devices.filter(d => d.kind === 'videoinput'),
    audio: devices.filter(d => d.kind === 'audioinput'),
  };
}

export function matchDevice(devices, savedLabel, savedId) {
  if (savedLabel) {
    const byLabel = devices.find(d => d.label === savedLabel);
    if (byLabel) return byLabel;
  }
  if (savedId) {
    const byId = devices.find(d => d.deviceId === savedId);
    if (byId) return byId;
  }
  return null;
}

export function onDeviceChange(callback) {
  navigator.mediaDevices.addEventListener('devicechange', callback);
}

export async function openStream(videoDeviceId, audioDeviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: videoDeviceId }, width: { ideal: 720 }, height: { ideal: 480 } },
    audio: { deviceId: { exact: audioDeviceId } },
  });
}

export async function openWebcamStream(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId } },
    audio: false,
  });
}

export function isChrome() {
  return /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent);
}

export function hasFileSystemAccess() {
  return 'showDirectoryPicker' in window;
}
