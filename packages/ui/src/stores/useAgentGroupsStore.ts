import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryStore } from './useDirectoryStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { listWorktrees, mapWorktreeToMetadata } from '@/lib/git/worktreeService';
import type { Session } from '@opencode-ai/sdk';

const OPENCHAMBER_DIR = '.openchamber';

/**
 * Parsed agent group from .openchamber folder structure.
 * Folder names follow pattern: `group-name-provider-model-<count>`
 * Example: `agent-manager-2-github-copilot-claude-opus-4-5-1`
 */
export interface AgentGroupSession {
  /** Session ID (same as folder name for now) */
  id: string;
  /** OpenCode session ID (from session.list API) */
  opencodeSessionId: string | null;
  /** Full worktree path */
  path: string;
  /** Provider ID extracted from folder name */
  providerId: string;
  /** Model ID extracted from folder name */
  modelId: string;
  /** Instance number for duplicate model selections */
  instanceNumber: number;
  /** Branch name associated with this worktree */
  branch: string;
  /** Display label for the model */
  displayLabel: string;
  /** Full worktree metadata */
  worktreeMetadata?: WorktreeMetadata;
}

export interface AgentGroup {
  /** Group name (e.g., "agent-manager-2", "contributing") */
  name: string;
  /** Sessions within this group (one per model instance) */
  sessions: AgentGroupSession[];
  /** Timestamp of last activity (most recent session) */
  lastActive: number;
  /** Total session count */
  sessionCount: number;
}

interface AgentGroupsState {
  /** All discovered agent groups from .openchamber folder */
  groups: AgentGroup[];
  /** Currently selected group name */
  selectedGroupName: string | null;
  /** Currently selected session ID within the group */
  selectedSessionId: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
}

interface AgentGroupsActions {
  /** Load/refresh agent groups from .openchamber folder */
  loadGroups: () => Promise<void>;
  /** Select a group */
  selectGroup: (groupName: string | null) => void;
  /** Select a session within the current group */
  selectSession: (sessionId: string | null) => void;
  /** Get the currently selected group */
  getSelectedGroup: () => AgentGroup | null;
  /** Get the currently selected session */
  getSelectedSession: () => AgentGroupSession | null;
  /** Clear error */
  clearError: () => void;
}

type AgentGroupsStore = AgentGroupsState & AgentGroupsActions;

/**
 * Parse a worktree folder name into group components.
 * Expected format: `<group-name>-<provider>-<model>-<instance>`
 * 
 * Example: "agent-manager-2-github-copilot-claude-opus-4-5-1"
 * - groupName: "agent-manager-2"
 * - provider: "github-copilot"
 * - model: "claude-opus-4-5"
 * - instance: 1
 */
function parseWorktreeFolderName(folderName: string): {
  groupName: string;
  providerId: string;
  modelId: string;
  instanceNumber: number;
} | null {
  // Match pattern: ends with -<number>
  const instanceMatch = folderName.match(/-(\d+)$/);
  if (!instanceMatch) {
    return null;
  }
  
  const instanceNumber = parseInt(instanceMatch[1], 10);
  const withoutInstance = folderName.slice(0, -instanceMatch[0].length);
  
  // Known provider patterns (ordered by specificity)
  const knownProviders = [
    'github-copilot',
    'opencode',
    'openrouter',
    'anthropic',
    'openai',
    'google',
    'aws-bedrock',
    'azure',
    'groq',
    'ollama',
    'together',
    'deepseek',
    'mistral',
    'cohere',
    'fireworks',
    'perplexity',
    'xai',
  ];
  
  // Try to find a known provider in the string
  for (const provider of knownProviders) {
    const providerIndex = withoutInstance.lastIndexOf(`-${provider}-`);
    if (providerIndex !== -1) {
      const groupName = withoutInstance.slice(0, providerIndex);
      const afterProvider = withoutInstance.slice(providerIndex + provider.length + 2);
      const modelId = afterProvider;
      
      if (groupName && modelId) {
        return {
          groupName,
          providerId: provider,
          modelId,
          instanceNumber,
        };
      }
    }
  }
  
  // Fallback: try to split by common patterns
  // Pattern: <group>-<single-word-provider>-<model>-<instance>
  const parts = withoutInstance.split('-');
  if (parts.length >= 3) {
    // Assume last part is model, second-to-last might be provider
    // This is a heuristic and may need adjustment
    const potentialModel = parts.slice(-2).join('-');
    const potentialProvider = parts.slice(-3, -2).join('-');
    const potentialGroup = parts.slice(0, -3).join('-');
    
    if (potentialGroup && potentialProvider && potentialModel) {
      return {
        groupName: potentialGroup,
        providerId: potentialProvider,
        modelId: potentialModel,
        instanceNumber,
      };
    }
  }
  
  return null;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '');
};

/**
 * Parse a session title to extract group, provider, model, and optional index.
 * Title format: groupSlug/provider/model or groupSlug/provider/model/index
 * 
 * Example: "my-feature/anthropic/claude-sonnet-4-20250514" -> { groupSlug: "my-feature", provider: "anthropic", model: "claude-sonnet-4-20250514", index: undefined }
 * Example: "my-feature/anthropic/claude-sonnet-4-20250514/2" -> { groupSlug: "my-feature", provider: "anthropic", model: "claude-sonnet-4-20250514", index: 2 }
 */
function parseSessionTitle(title: string | undefined): {
  groupSlug: string;
  provider: string;
  model: string;
  index?: number;
} | null {
  if (!title) return null;
  
  const parts = title.split('/');
  if (parts.length < 3) return null;
  
  // Check if last part is a number (index)
  const lastPart = parts[parts.length - 1];
  const lastPartNum = parseInt(lastPart, 10);
  const hasIndex = parts.length >= 4 && !isNaN(lastPartNum) && String(lastPartNum) === lastPart;
  
  if (hasIndex) {
    // Format: groupSlug/provider/model/index
    const groupSlug = parts.slice(0, -3).join('/');
    const provider = parts[parts.length - 3];
    const model = parts[parts.length - 2];
    return { groupSlug, provider, model, index: lastPartNum };
  } else {
    // Format: groupSlug/provider/model
    const groupSlug = parts.slice(0, -2).join('/');
    const provider = parts[parts.length - 2];
    const model = parts[parts.length - 1];
    return { groupSlug, provider, model };
  }
}

/**
 * Generate a git-safe slug from a string (matches useMultiRunStore logic).
 */
const toGitSafeSlug = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
};

export const useAgentGroupsStore = create<AgentGroupsStore>()(
  devtools(
    (set, get) => ({
      groups: [],
      selectedGroupName: null,
      selectedSessionId: null,
      isLoading: false,
      error: null,

      loadGroups: async () => {
        const currentDirectory = useDirectoryStore.getState().currentDirectory;
        if (!currentDirectory) {
          set({ groups: [], isLoading: false, error: 'No project directory selected' });
          return;
        }

        // Check if we're inside a .openchamber worktree - if so, don't reload
        // This prevents groups from disappearing when switching to a worktree session
        const normalizedCurrent = normalize(currentDirectory);
        if (normalizedCurrent.includes(`/${OPENCHAMBER_DIR}/`)) {
          // We're inside a worktree, don't reload groups
          set({ isLoading: false });
          return;
        }

        const previousGroups = get().groups;
        set({ isLoading: true, error: null });

        try {
          const normalizedProject = normalizedCurrent;
          const openchamberPath = `${normalizedProject}/${OPENCHAMBER_DIR}`;

          // Fetch all OpenCode sessions first
          const apiClient = opencodeClient.getApiClient();
          const allSessions: Session[] = [];
          try {
            // Get sessions from the main project directory
            const mainResponse = await apiClient.session.list({
              query: { directory: normalizedProject },
            });
            if (Array.isArray(mainResponse.data)) {
              allSessions.push(...mainResponse.data);
            }
          } catch (err) {
            console.debug('Failed to fetch sessions from main directory:', err);
            // Don't fail completely, continue with filesystem-based discovery
          }

          // First check if .openchamber directory exists
          let dirEntries: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          try {
            const projectEntries = await opencodeClient.listLocalDirectory(normalizedProject);
            const openchamberExists = projectEntries.some(
              (entry) => entry.name === OPENCHAMBER_DIR && entry.isDirectory
            );
            
            if (openchamberExists) {
              dirEntries = await opencodeClient.listLocalDirectory(openchamberPath);
              
              // Also fetch sessions from each worktree directory
              const worktreeDirs = dirEntries.filter((entry) => entry.isDirectory);
              for (const worktreeDir of worktreeDirs) {
                const worktreePath = normalize(worktreeDir.path) || `${openchamberPath}/${worktreeDir.name}`;
                try {
                  const response = await apiClient.session.list({
                    query: { directory: worktreePath },
                  });
                  console.log('Fetched sessions for worktree:', worktreePath, response);
                  if (Array.isArray(response.data)) {
                    allSessions.push(...response.data);
                  }
                } catch {
                  // Ignore errors for individual worktrees
                }
              }
            }
          } catch (err) {
            console.debug('Failed to list .openchamber directory:', err);
          }

          // Dedupe sessions by ID
          const sessionMap = new Map<string, Session>();
          for (const session of allSessions) {
            sessionMap.set(session.id, session);
          }
          const dedupedSessions = Array.from(sessionMap.values());

          // Build a map of session titles to session data for quick lookup
          // Key format: "groupSlug:provider:modelSlug:index" where index may be undefined
          // We slugify the model ID to match how worktree folder names are created
          const sessionsByPattern = new Map<string, Session>();
          for (const session of dedupedSessions) {
            const parsed = parseSessionTitle(session.title);
            if (parsed) {
              // Slugify provider and model to match folder naming convention
              const providerSlug = toGitSafeSlug(parsed.provider);
              const modelSlug = toGitSafeSlug(parsed.model);
              const key = `${parsed.groupSlug}:${providerSlug}:${modelSlug}:${parsed.index ?? 1}`;
              sessionsByPattern.set(key, session);
            }
          }

          // Filter to only directories (worktrees)
          const worktreeFolders = dirEntries.filter((entry) => entry.isDirectory);

          // Get git worktree info for metadata
          let worktreeInfoList: Awaited<ReturnType<typeof listWorktrees>> = [];
          try {
            worktreeInfoList = await listWorktrees(normalizedProject);
          } catch (err) {
            console.debug('Failed to list git worktrees:', err);
          }

          // Create a map for quick lookup
          const worktreeInfoMap = new Map(
            worktreeInfoList.map((info) => [normalize(info.worktree), info])
          );

          // Parse folders and group by group name
          const groupsMap = new Map<string, AgentGroupSession[]>();

          for (const folder of worktreeFolders) {
            const parsed = parseWorktreeFolderName(folder.name);
            if (!parsed) {
              continue;
            }

            const fullPath = normalize(folder.path) || `${openchamberPath}/${folder.name}`;
            const worktreeInfo = worktreeInfoMap.get(fullPath);
            
            // Find matching OpenCode session by pattern
            // The session title format is: groupSlug/provider/model or groupSlug/provider/model/index
            const sessionKey = `${parsed.groupName}:${parsed.providerId}:${parsed.modelId}:${parsed.instanceNumber}`;
            const matchedSession = sessionsByPattern.get(sessionKey);
            
            const session: AgentGroupSession = {
              id: folder.name,
              opencodeSessionId: matchedSession?.id ?? null,
              path: fullPath,
              providerId: parsed.providerId,
              modelId: parsed.modelId,
              instanceNumber: parsed.instanceNumber,
              branch: worktreeInfo?.branch ?? '',
              displayLabel: `${parsed.providerId}/${parsed.modelId}`,
              worktreeMetadata: worktreeInfo
                ? mapWorktreeToMetadata(normalizedProject, worktreeInfo)
                : undefined,
            };

            const existing = groupsMap.get(parsed.groupName);
            if (existing) {
              existing.push(session);
            } else {
              groupsMap.set(parsed.groupName, [session]);
            }
          }

          // Convert map to array and sort
          const groups: AgentGroup[] = Array.from(groupsMap.entries()).map(
            ([name, sessions]) => ({
              name,
              sessions: sessions.sort((a, b) => {
                // Sort by provider, then model, then instance
                const providerCmp = a.providerId.localeCompare(b.providerId);
                if (providerCmp !== 0) return providerCmp;
                const modelCmp = a.modelId.localeCompare(b.modelId);
                if (modelCmp !== 0) return modelCmp;
                return a.instanceNumber - b.instanceNumber;
              }),
              lastActive: Date.now(), // TODO: Get actual timestamp from session metadata
              sessionCount: sessions.length,
            })
          );

          // Sort groups by name (could also sort by lastActive)
          groups.sort((a, b) => a.name.localeCompare(b.name));
          console.log(groups);
          set({ groups, isLoading: false, error: null });
        } catch (err) {
          console.error('Failed to load agent groups:', err);
          // Preserve existing groups on error to avoid UI flickering
          set({
            // Keep previousGroups if we have them, only clear if we had none
            groups: previousGroups.length > 0 ? previousGroups : [],
            isLoading: false,
            error: err instanceof Error ? err.message : 'Failed to load agent groups',
          });
        }
      },

      selectGroup: (groupName) => {
        const { groups } = get();
        const group = groups.find((g) => g.name === groupName);
        
        set({
          selectedGroupName: groupName,
          // Auto-select first session when selecting a group
          selectedSessionId: group?.sessions[0]?.id ?? null,
        });
      },

      selectSession: (sessionId) => {
        set({ selectedSessionId: sessionId });
      },

      getSelectedGroup: () => {
        const { groups, selectedGroupName } = get();
        if (!selectedGroupName) return null;
        return groups.find((g) => g.name === selectedGroupName) ?? null;
      },

      getSelectedSession: () => {
        const { selectedSessionId } = get();
        const group = get().getSelectedGroup();
        if (!group || !selectedSessionId) return null;
        return group.sessions.find((s) => s.id === selectedSessionId) ?? null;
      },

      clearError: () => {
        set({ error: null });
      },
    }),
    { name: 'agent-groups-store' }
  )
);
