// Modern SVG icon components for Harness Remote

export const SettingsIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Settings"
  >
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)

export const FolderIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Sessions"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
  </svg>
)

export const ChatIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Detail"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    <path d="M8 10h.01"/>
    <path d="M12 10h.01"/>
    <path d="M16 10h.01"/>
  </svg>
)

export const PlusIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Add"
  >
    <path d="M5 12h14"/>
    <path d="M12 5v14"/>
  </svg>
)

export const TrashIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Delete"
  >
    <path d="M3 6h18"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
)

export const StopCircleIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Stop task"
  >
    <circle cx="12" cy="12" r="10"/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
)

export const PaperclipIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Attach"
  >
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
  </svg>
)

export const PhoneIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </svg>
)

export const LoadingIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={`${className} animate-spin`}
    role="img"
    aria-label="Loading"
  >
    <path d="M21 12a9 9 0 11-6.219-8.56"/>
  </svg>
)

export const RefreshIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Refresh"
  >
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 15"/>
    <path d="M3 21v-6h6"/>
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 9"/>
    <path d="M21 3v6h-6"/>
  </svg>
)

export const PencilIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Edit"
  >
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
  </svg>
)

export const CloseIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Close"
  >
    <path d="M18 6L6 18"/>
    <path d="M6 6l12 12"/>
  </svg>
)
export const JumpToTopIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Jump to top"
  >
    <path d="M5 4h14" />
    <path d="M12 20V9" />
    <path d="M6 15l6-6 6 6" />
  </svg>
)

export const JumpToBottomIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Jump to bottom"
  >
    <path d="M5 20h14" />
    <path d="M12 4v11" />
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const SearchIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Search"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
)

export const ChevronDownIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Expand"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const CommandIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Commands"
  >
    <path d="M15 6a3 3 0 1 1 3 3h-3zm0 0v12m0 0a3 3 0 1 0 3-3h-3zM9 6a3 3 0 1 0-3 3h3zm0 0v12m0 0a3 3 0 1 1-3-3h3zM9 9h6v6H9z" />
  </svg>
)

export const ServerIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Server"
  >
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
)

export const SparkIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Model"
  >
    <path d="M12 3l1.9 4.9L19 9.8l-4.4 2.6L13.4 18 12 14.3 10.6 18l-1.2-5.6L5 9.8l5.1-1.9z" />
  </svg>
)

export const CopyIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Copy"
  >
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

export const CheckIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Done"
  >
    <path d="m5 13 4 4L19 7" />
  </svg>
)
export const TaskListIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Tasks"
  >
    <path d="m3 6 2 2 3.5-3.5" />
    <path d="m3 13 2 2 3.5-3.5" />
    <path d="M13 6h8" />
    <path d="M13 13h8" />
    <path d="M4 20h17" />
  </svg>
)

export const AgentIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Agents"
  >
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4" />
    <circle cx="9" cy="14" r="1" />
    <circle cx="15" cy="14" r="1" />
  </svg>
)

export const PuzzleIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Plugins"
  >
    <path d="M8.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v1.2a2.3 2.3 0 1 0 4.6 0V5a1.5 1.5 0 0 1 1.5-1.5h.4v4a1.5 1.5 0 0 1-1.5 1.5h-1.2a2.3 2.3 0 1 0 0 4.6H19a1.5 1.5 0 0 1 1.5 1.5v4h-4a1.5 1.5 0 0 1-1.5-1.5v-1.2a2.3 2.3 0 1 0-4.6 0V19a1.5 1.5 0 0 1-1.5 1.5h-4v-4a1.5 1.5 0 0 1 1.5-1.5h1.2a2.3 2.3 0 1 0 0-4.6H5A1.5 1.5 0 0 1 3.5 9V5h4Z" />
  </svg>
)

export const AlertIcon = ({ className = "", size = 20 }: { className?: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    role="img"
    aria-label="Needs you"
  >
    <path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
)
