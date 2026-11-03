import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "./voice-commands";

describe("parseVoiceCommand", () => {
  it.each([
    ["I'm here", "arrive"], ["I have arrived", "arrive"], ["Je suis là", "arrive"], ["delivered", "complete"], ["mark it done", "complete"], ["Livré", "complete"],
    ["can't deliver", "fail"], ["nobody home", "fail"], ["next stop", "navigate"], ["navigate", "navigate"], ["prochain arrêt", "navigate"],
    ["I need help", "help"], ["j'ai besoin d'aide", "help"], ["start my break", "break_start"], ["fin de la pause", "break_end"], ["end my break", "break_end"], ["end my shift", "shift_end"],
  ])("%s -> %s", (text, action) => { expect(parseVoiceCommand(text)?.action).toBe(action); });

  it("passes on a message to dispatch", () => {
    expect(parseVoiceCommand("message running ten minutes late")).toEqual({ action: "message", text: "running ten minutes late" });
  });
  it("ignores chatter and empty input", () => {
    expect(parseVoiceCommand("what a nice day")).toBeNull();
    expect(parseVoiceCommand("   ")).toBeNull();
    expect(parseVoiceCommand("a".repeat(300))).toBeNull();
  });
  it("does not mistake ending a break for starting one", () => {
    expect(parseVoiceCommand("end break")?.action).toBe("break_end");
    expect(parseVoiceCommand("start lunch")?.action).toBe("break_start");
  });
});
