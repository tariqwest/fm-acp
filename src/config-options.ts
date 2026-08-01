import type {
  BackendId,
  Guardrails,
  ModelAvailability,
  ModelId,
  UseCase,
} from "./types.ts";

export const MODEL_CONFIG_ID = "model";
export const BACKEND_CONFIG_ID = "backend";
export const INSTRUCTIONS_CONFIG_ID = "instructions";
export const USE_CASE_CONFIG_ID = "use_case";
export const GUARDRAILS_CONFIG_ID = "guardrails";
export const GREEDY_CONFIG_ID = "greedy";
export const BRIDGE_CONFIG_ID = "bridge";

export type SelectOption = { value: string; name: string };

export type SessionConfigOption =
  | {
      id: string;
      name: string;
      category: string;
      type: "select";
      currentValue: string;
      options: SelectOption[];
    }
  | {
      id: string;
      name: string;
      category: string;
      type: "boolean";
      currentValue: boolean;
    }
  | {
      id: string;
      name: string;
      category: string;
      type: "string";
      currentValue: string;
    };

export type ConfigState = {
  modelId: ModelId | null;
  backendId: BackendId | null;
  instructions: string | null;
  useCase: UseCase | null;
  guardrails: Guardrails | null;
  greedy: boolean | null;
  bridgeEnabled: boolean | null;
};

function modelLabel(m: ModelAvailability): string {
  const base = m.id === "system" ? "System (on-device)" : "PCC (Private Cloud Compute)";
  if (m.runnableInCurrentProcess) return base;
  if (m.available) return `${base} — available, not runnable here`;
  return `${base} — unavailable`;
}

export function buildSessionConfigOptions(opts: {
  models: ModelAvailability[];
  state: ConfigState;
  hasAfm: boolean;
  hasFm: boolean;
}): SessionConfigOption[] {
  const modelOptions = (opts.models.length
    ? opts.models
    : [
        { id: "system" as const, available: true, runnableInCurrentProcess: true },
        { id: "pcc" as const, available: false, runnableInCurrentProcess: false },
      ]
  ).map((m) => ({ value: m.id, name: modelLabel(m) }));

  const currentModel = opts.state.modelId ?? "system";
  const backendOptions: SelectOption[] = [
    { value: "auto", name: "Auto (afm if present, else fm)" },
  ];
  if (opts.hasAfm) backendOptions.push({ value: "afm", name: "afm (Foundation Models Framework CLI)" });
  if (opts.hasFm) backendOptions.push({ value: "fm", name: "System fm (/usr/bin/fm)" });

  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: modelOptions,
    },
    {
      id: BACKEND_CONFIG_ID,
      name: "Backend",
      category: "model_config",
      type: "select",
      currentValue: opts.state.backendId ?? "auto",
      options: backendOptions,
    },
    {
      id: INSTRUCTIONS_CONFIG_ID,
      name: "Instructions",
      category: "model_config",
      type: "string",
      currentValue: opts.state.instructions ?? "",
    },
    {
      id: USE_CASE_CONFIG_ID,
      name: "Use case",
      category: "model_config",
      type: "select",
      currentValue: opts.state.useCase ?? "general",
      options: [
        { value: "general", name: "General" },
        { value: "content-tagging", name: "Content tagging" },
      ],
    },
    {
      id: GUARDRAILS_CONFIG_ID,
      name: "Guardrails",
      category: "model_config",
      type: "select",
      currentValue: opts.state.guardrails ?? "default",
      options: [
        { value: "default", name: "Default" },
        {
          value: "permissive-content-transformations",
          name: "Permissive content transformations",
        },
      ],
    },
    {
      id: GREEDY_CONFIG_ID,
      name: "Greedy sampling",
      category: "model_config",
      type: "boolean",
      currentValue: Boolean(opts.state.greedy),
    },
    {
      id: BRIDGE_CONFIG_ID,
      name: "Use afm bridge for PCC",
      category: "model_config",
      type: "boolean",
      currentValue: opts.state.bridgeEnabled !== false,
    },
  ];
}

export function applyConfigOptionValue(opts: {
  configId: string;
  value: unknown;
  state: ConfigState;
}): ConfigState {
  const next = { ...opts.state };
  const { configId, value } = opts;

  switch (configId) {
    case MODEL_CONFIG_ID: {
      const v = String(value);
      if (v !== "system" && v !== "pcc") {
        throw Object.assign(new Error(`invalid model: ${v}`), { code: -32602 });
      }
      next.modelId = v;
      break;
    }
    case BACKEND_CONFIG_ID: {
      const v = String(value);
      if (v !== "auto" && v !== "afm" && v !== "fm") {
        throw Object.assign(new Error(`invalid backend: ${v}`), { code: -32602 });
      }
      next.backendId = v;
      break;
    }
    case INSTRUCTIONS_CONFIG_ID: {
      next.instructions = String(value ?? "");
      break;
    }
    case USE_CASE_CONFIG_ID: {
      const v = String(value);
      if (v !== "general" && v !== "content-tagging") {
        throw Object.assign(new Error(`invalid use_case: ${v}`), { code: -32602 });
      }
      next.useCase = v;
      break;
    }
    case GUARDRAILS_CONFIG_ID: {
      const v = String(value);
      if (v !== "default" && v !== "permissive-content-transformations") {
        throw Object.assign(new Error(`invalid guardrails: ${v}`), { code: -32602 });
      }
      next.guardrails = v;
      break;
    }
    case GREEDY_CONFIG_ID: {
      next.greedy = value === true || value === "true" || value === "on" || value === 1;
      break;
    }
    case BRIDGE_CONFIG_ID: {
      next.bridgeEnabled = value === true || value === "true" || value === "on" || value === 1;
      break;
    }
    default:
      throw Object.assign(new Error(`unknown configId: ${configId}`), { code: -32602 });
  }
  return next;
}
