import React from 'react';
import {
  RiAddCircleLine,
  RiArrowDownSLine,
  RiAttachment2,
  RiGitBranchLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { ProviderLogo } from '@/components/ui/ProviderLogo';

interface AgentManagerEmptyStateProps {
  className?: string;
}

export const AgentManagerEmptyState: React.FC<AgentManagerEmptyStateProps> = ({ className }) => {
  const { currentProviderId, currentModelId, getCurrentProvider, currentAgentName } = useConfigStore();
  
  const currentProvider = getCurrentProvider();
  const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];
  const currentModel = models.find((m: { id?: string }) => m.id === currentModelId);
  
  const modelDisplayName = currentModel?.name || currentModelId || 'Select model';
  const agentDisplayName = currentAgentName 
    ? currentAgentName.charAt(0).toUpperCase() + currentAgentName.slice(1)
    : 'Build';
  
  return (
    <div className={cn('flex flex-col items-center justify-center h-full w-full', className)}>
      {/* Centered Chat Input Mockup */}
      <div className="w-full max-w-2xl px-4">
        <div className="rounded-xl border border-border/60 bg-input/10 dark:bg-input/30 overflow-hidden">
          {/* Text Area */}
          <div className="px-4 py-4 min-h-[80px]">
            <span className="typography-markdown text-muted-foreground/50">
              Ask anything...
            </span>
          </div>
          
          {/* Footer Controls */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
            {/* Left Controls */}
            <div className="flex items-center gap-2">
              {/* Add attachment button */}
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Add attachment"
              >
                <RiAddCircleLine className="h-[18px] w-[18px]" />
              </button>
              
              {/* Attach files button */}
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Attach files"
              >
                <RiAttachment2 className="h-[18px] w-[18px]" />
              </button>
            </div>
            
            {/* Right Controls - Model/Agent Selector */}
            <div className="flex items-center gap-3">
              {/* Model Selector */}
              <button
                type="button"
                className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                {currentProviderId && (
                  <ProviderLogo
                    providerId={currentProviderId}
                    className="h-4 w-4 flex-shrink-0"
                  />
                )}
                <span className="typography-meta font-medium truncate max-w-[160px]">
                  {modelDisplayName}
                </span>
              </button>
              
              {/* Agent Selector */}
              <button
                type="button"
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <span className="typography-meta font-medium">
                  {agentDisplayName}
                </span>
                <RiArrowDownSLine className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
        
        {/* Worktree/Branch Dropdowns */}
        <div className="flex items-center justify-center gap-4 mt-4">
          {/* Worktree Dropdown */}
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/40 bg-background/50 hover:bg-background/80 transition-colors"
          >
            <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
            <span className="typography-meta text-foreground">Worktree</span>
            <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
          </button>
          
          {/* Branch Dropdown */}
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/40 bg-background/50 hover:bg-background/80 transition-colors"
          >
            <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
            <span className="typography-meta text-foreground">Branch</span>
            <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
};
