import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiMore2Line,
  RiSearchLine,
} from '@remixicon/react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Mock data for the agent sessions
const MOCK_SESSIONS = [
  { id: '1', title: 'Test conversation', lastActive: Date.now() - 60 * 60 * 1000 }, // 1h ago
  { id: '2', title: 'Understanding MongoDB aggregation pipelines', lastActive: Date.now() - 386 * 24 * 60 * 60 * 1000 }, // 386d ago
  { id: '3', title: 'Refactoring auth module', lastActive: Date.now() - 2 * 24 * 60 * 60 * 1000 }, // 2d ago
  { id: '4', title: 'Bug fix in payment flow', lastActive: Date.now() - 7 * 24 * 60 * 60 * 1000 }, // 7d ago
  { id: '5', title: 'API documentation review', lastActive: Date.now() - 14 * 24 * 60 * 60 * 1000 }, // 14d ago
  { id: '6', title: 'Performance optimization', lastActive: Date.now() - 30 * 24 * 60 * 60 * 1000 }, // 30d ago
  { id: '7', title: 'Unit test coverage', lastActive: Date.now() - 45 * 24 * 60 * 60 * 1000 }, // 45d ago
  { id: '8', title: 'Migration to TypeScript', lastActive: Date.now() - 60 * 24 * 60 * 60 * 1000 }, // 60d ago
];

const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / (60 * 1000));
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
};

interface AgentSession {
  id: string;
  title: string;
  lastActive: number;
}

interface AgentListItemProps {
  session: AgentSession;
  isSelected: boolean;
  onSelect: () => void;
}

const AgentListItem: React.FC<AgentListItemProps> = ({ session, isSelected, onSelect }) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1.5 cursor-pointer',
        isSelected ? 'dark:bg-accent/80 bg-primary/12' : 'hover:dark:bg-accent/40 hover:bg-primary/6',
      )}
      onClick={onSelect}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <span className="truncate typography-ui-label font-normal text-foreground">
            {session.title}
          </span>
          <span className="typography-micro text-muted-foreground/60">
            {formatRelativeTime(session.lastActive)}
          </span>
        </button>
        
        <div className="flex items-center gap-1.5 self-stretch">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-3.5 w-[18px] items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  'opacity-0 group-hover:opacity-100',
                  menuOpen && 'opacity-100',
                )}
                aria-label="Session menu"
                onClick={(e) => e.stopPropagation()}
              >
                <RiMore2Line className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              <DropdownMenuItem>Rename</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuItem className="text-destructive focus:text-destructive">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
};

interface AgentManagerSidebarProps {
  className?: string;
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
  onNewAgent?: () => void;
}

export const AgentManagerSidebar: React.FC<AgentManagerSidebarProps> = ({
  className,
  selectedSessionId,
  onSessionSelect,
  onNewAgent,
}) => {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  
  const MAX_VISIBLE = 5;
  
  const filteredSessions = React.useMemo(() => {
    if (!searchQuery.trim()) return MOCK_SESSIONS;
    const query = searchQuery.toLowerCase();
    return MOCK_SESSIONS.filter(session => 
      session.title.toLowerCase().includes(query)
    );
  }, [searchQuery]);
  
  const visibleSessions = showAll ? filteredSessions : filteredSessions.slice(0, MAX_VISIBLE);
  const remainingCount = filteredSessions.length - MAX_VISIBLE;
  
  return (
    <div className={cn('flex h-full flex-col bg-background/50 dark:bg-neutral-900/80 text-foreground border-r border-border/30', className)}>
      {/* Search Input */}
      <div className="px-2.5 pt-3 pb-2">
        <div className="relative">
          <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Agents..."
            className="pl-8 h-8 rounded-lg border-border/40 bg-background/50 typography-meta"
          />
        </div>
      </div>
      
      {/* New Agent Button */}
      <div className="px-2.5 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 h-8"
          onClick={onNewAgent}
        >
          <RiAddLine className="h-4 w-4" />
          <span className="typography-ui-label">New Agent</span>
        </Button>
      </div>
      
      {/* Agents Section Header */}
      <div className="px-2.5 py-1.5 flex items-center gap-1">
        <RiArrowDownSLine className="h-4 w-4 text-muted-foreground" />
        <span className="typography-micro font-medium text-muted-foreground uppercase tracking-wider">
          Agents
        </span>
      </div>
      
      {/* Session List */}
      <ScrollableOverlay
        outerClassName="flex-1 min-h-0"
        className="space-y-0.5 px-2.5 pb-2"
      >
        {visibleSessions.map((session) => (
          <AgentListItem
            key={session.id}
            session={session}
            isSelected={selectedSessionId === session.id}
            onSelect={() => onSessionSelect?.(session.id)}
          />
        ))}
        
        {/* Show More Link */}
        {!showAll && remainingCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-1 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left typography-micro text-muted-foreground/70 hover:text-foreground hover:underline"
          >
            ... More ({remainingCount})
          </button>
        )}
        
        {/* Show Less Link */}
        {showAll && filteredSessions.length > MAX_VISIBLE && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="mt-1 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left typography-micro text-muted-foreground/70 hover:text-foreground hover:underline"
          >
            Show less
          </button>
        )}
        
        {/* Empty State */}
        {filteredSessions.length === 0 && (
          <div className="py-4 text-center">
            <p className="typography-meta text-muted-foreground">
              No agents found
            </p>
          </div>
        )}
      </ScrollableOverlay>
    </div>
  );
};
