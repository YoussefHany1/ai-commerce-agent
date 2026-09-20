'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useChatMutation() {
  return useMutation({
    mutationFn: ({ storeId, message }: { storeId: string; message: string }) =>
      api.chat(storeId, message),
  });
}