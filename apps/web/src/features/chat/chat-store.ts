import { create } from 'zustand';

interface ChatUiState {
  activeConversationId: string | null;
  draft: string;
  setActiveConversationId(id: string | null): void;
  setDraft(draft: string): void;
}

export const useChatUi = create<ChatUiState>((set) => ({
  activeConversationId: null,
  draft: '',
  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),
  setDraft: (draft) => set({ draft }),
}));
