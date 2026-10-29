// Load repository templates once at startup. Published versions override these defaults.
import { readFileSync } from 'node:fs';

function readTemplate(name) {
  // Resolve from this module so CLI, tests and Docker do not depend on process.cwd().
  const text = readFileSync(new URL(`../../prompts/${name}`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (!text.trim()) throw new Error(`Empty prompt template: ${name}`);
  return text;
}

export const SEED_CHARACTER = readTemplate('character.md');
const response = readTemplate('response.md');
export const GROUP_RULES = [readTemplate('group.md'), response];
export const PRIVATE_RULES = [readTemplate('private.md'), response];
export const IDENTITY_LINES = [readTemplate('identity.md')];
export const DISTILL_SYSTEM_TEMPLATE = readTemplate('distill.md');
export const SCENE_TEMPLATE = readTemplate('scene.md');
export const SYSTEM_TEMPLATE = readTemplate('system.md');
export const TOOL_RULES = readTemplate('tool-rules.md');
export const MEME_TOOL_RULES = readTemplate('meme-rules.md');
export const POKE_PROMPT = readTemplate('poke.md');
export const POKE_SYSTEM_TEMPLATE = readTemplate('poke-system.md');
const toolDescriptions = JSON.parse(readTemplate('tools.json'));

export function defaultPromptConfig({ historyLimit = 20, budgetBytes = 12000 } = {}) {
  return {
    prompts: { seed: SEED_CHARACTER, identity: IDENTITY_LINES.join('\n'), group: GROUP_RULES.join('\n'), private: PRIVATE_RULES.join('\n'), scene: SCENE_TEMPLATE, toolRules: TOOL_RULES + '\n' + MEME_TOOL_RULES, distill: DISTILL_SYSTEM_TEMPLATE },
    context: { historyLimit, budgetBytes, maxAgeMinutes: 0, users: true, assistant: true, text: true, image: true, excludeCommands: false, onlySpeaker: false, injectMemory: true, vision: true },
    tools: {
      draw: { enabled: true, ...toolDescriptions.draw },
      remember_fact: { enabled: true, ...toolDescriptions.remember_fact },
      recall_memory: { enabled: true, ...toolDescriptions.recall_memory },
      save_meme: { enabled: true, ...toolDescriptions.save_meme },
      search_memes: { enabled: true, ...toolDescriptions.search_memes },
      send_meme: { enabled: true, ...toolDescriptions.send_meme },
    },
    execution: { maxToolRounds: 3, maxToolCalls: 4 },
  };
}
