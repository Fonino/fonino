import { DeviceRegistry, MockAdapter } from "@agentphone/device-core";
import { AndroidAdapter } from "./android.ts";
import { IPhoneMirroringAdapter } from "./mirroring.ts";
import { IPhoneWdaAdapter } from "./wda.ts";

export { AndroidAdapter, AndroidDevice, ANDROID_ADAPTER, adbPath } from "./android.ts";
export { IPhoneMirroringAdapter, MIRROR_DEVICE_ID, nativeBinPath, runNative } from "./mirroring.ts";
export { IPhoneWdaAdapter, inSettings, setAutoLockNever, setChargeLimit80 } from "./wda.ts";
export { isTrusted, listMuxDevices, lockdownGetValues, modelName, type MuxDevice } from "./usbmux.ts";
export { devModeStatus, goios, goiosPath, helperBundleId, mountDeveloperImage, revealDevMode, useGoios } from "./goios.ts";
export { WdaSupervisor, type SupervisedPhone, type PhoneHealth } from "./wda-supervisor.ts";

/**
 * The registry every entry point (CLI, MCP, web bridge) uses, so they all share
 * one device-control implementation. AGENTPHONE_ADAPTERS picks adapters
 * (default "mirroring,wda,android"; android only lists phones when adb is installed);
 * AGENTPHONE_MOCK=1 adds two fake phones.
 */
export function createDefaultRegistry(): DeviceRegistry {
  const reg = new DeviceRegistry();
  const wanted = (process.env.AGENTPHONE_ADAPTERS ?? "mirroring,wda,android").split(",").map((s) => s.trim());
  if (wanted.includes("mirroring")) reg.register(new IPhoneMirroringAdapter());
  if (wanted.includes("wda")) reg.register(new IPhoneWdaAdapter());
  if (wanted.includes("android")) reg.register(new AndroidAdapter());
  if (process.env.AGENTPHONE_MOCK === "1" || wanted.includes("mock")) reg.register(new MockAdapter());
  return reg;
}
