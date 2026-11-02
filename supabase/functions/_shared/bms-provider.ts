// Adapts the BMS client to the Provider interface used by the delivery logic.
import * as bms from "./bms.ts";
import type { Provider } from "./delivery.ts";

export const bmsProvider: Provider = {
  configured: bms.bmsConfigured,
  balance: bms.getVoiceBalance,
  sendVoice: bms.sendQuickVoice,
  report: bms.getCallReport,
  mapStatus: bms.mapCallStatus,
  phoneKey: bms.phoneKey,
};
