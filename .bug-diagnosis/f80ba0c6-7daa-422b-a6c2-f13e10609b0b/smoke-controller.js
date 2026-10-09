// Ephemeral smoke: real AgentController against the REAL ~/.aragon-agent file.
const { AgentController } = require('M:/takoAI/JRAgentMesh/aragon-agent-core/packages/cli/dist/agent/controller.js');
const { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME } = require('M:/takoAI/JRAgentMesh/aragon-agent-core/packages/cli/dist/config/schema.js');

const config = {
  ...DEFAULT_CONFIG, cwd: process.cwd(), color: true, unicode: true, submitCount: 0,
  startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
  provider: 'anthropic', model: 'kimi-k3', baseUrl: 'https://api.kimi.com/coding',
  contextWindow: null,
  skills: { ...DEFAULT_CONFIG.skills, enabled: false },
  compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
  team: { ...DEFAULT_CONFIG.team, enabled: false },
  fast: { ...DEFAULT_CONFIG.fast, enabled: false },
  apiKeys: { anthropic: 'k' },
};
const controller = new AgentController(config);
const usage = controller.getContextUsage();
console.log('window       :', usage.window);
console.log('windowKnown  :', usage.windowKnown);
console.log('windowSource :', usage.windowSource);
console.log('occupied>0   :', usage.occupied > 0, '(' + usage.occupied + ' tokens est.)');
controller.dispose();
