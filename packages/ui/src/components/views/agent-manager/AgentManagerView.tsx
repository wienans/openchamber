import React from 'react';
import { AgentManagerSidebar } from './AgentManagerSidebar';
import { AgentManagerEmptyState } from './AgentManagerEmptyState';
import { AgentRunDetail } from './AgentRunDetail';
import { cn } from '@/lib/utils';

// Mock data to map session IDs to run details
const MOCK_RUN_DETAILS: Record<string, { title: string; branch: string; worktree: string; timestamp: string }> = {
  '1': {
    title: 'Server 404 responses for API requests',
    branch: 'check-404-api-saj',
    worktree: 'check-404-api-saj',
    timestamp: 'Now',
  },
  '2': {
    title: 'Understanding MongoDB aggregation pipelines',
    branch: 'feature/mongodb-aggregation',
    worktree: 'mongodb-aggregation',
    timestamp: '386d ago',
  },
  '3': {
    title: 'Refactoring auth module',
    branch: 'refactor/auth-module',
    worktree: 'auth-refactor',
    timestamp: '2d ago',
  },
  '4': {
    title: 'Bug fix in payment flow',
    branch: 'fix/payment-flow',
    worktree: 'payment-fix',
    timestamp: '7d ago',
  },
  '5': {
    title: 'API documentation review',
    branch: 'docs/api-review',
    worktree: 'api-docs',
    timestamp: '14d ago',
  },
};

interface AgentManagerViewProps {
  className?: string;
}

export const AgentManagerView: React.FC<AgentManagerViewProps> = ({ className }) => {
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);

  const handleSessionSelect = React.useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
  }, []);

  const handleNewAgent = React.useCallback(() => {
    // Reset selection to show empty state / new agent flow
    setSelectedSessionId(null);
  }, []);

  const selectedRunDetails = selectedSessionId ? MOCK_RUN_DETAILS[selectedSessionId] : null;

  return (
    <div className={cn('flex h-full w-full bg-background', className)}>
      {/* Left Sidebar - Agent Sessions List */}
      <div className="w-64 flex-shrink-0">
        <AgentManagerSidebar
          selectedSessionId={selectedSessionId}
          onSessionSelect={handleSessionSelect}
          onNewAgent={handleNewAgent}
        />
      </div>
      
      {/* Main Content Area */}
      <div className="flex-1 min-w-0">
        {selectedRunDetails ? (
          <AgentRunDetail
            runId={selectedSessionId!}
            title={selectedRunDetails.title}
            branch={selectedRunDetails.branch}
            worktree={selectedRunDetails.worktree}
            timestamp={selectedRunDetails.timestamp}
          />
        ) : (
          <AgentManagerEmptyState />
        )}
      </div>
    </div>
  );
};
