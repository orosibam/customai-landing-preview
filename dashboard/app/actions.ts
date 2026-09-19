'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/supabase';

/**
 * 승인 게이트.
 *
 * 이 버튼이 "생성 100% 자동 + 배포만 승인" 의 전부다. 배포 워크플로는
 * approval_status = 'approved' 인 렌더만 집어간다.
 */
export async function decide(
  renderId: string,
  status: 'approved' | 'rejected' | 'regenerate',
): Promise<void> {
  await db()
    .from('renders')
    .update({
      approval_status: status,
      approved_at: status === 'approved' ? new Date().toISOString() : null,
    })
    .eq('id', renderId);

  revalidatePath('/');
}

/** 큐에 남은 걸 한 번에 승인한다. 목표는 하루 2분. */
export async function approveAll(runId: string): Promise<void> {
  await db()
    .from('renders')
    .update({ approval_status: 'approved', approved_at: new Date().toISOString() })
    .eq('run_id', runId)
    .eq('approval_status', 'pending')
    // QC를 통과하지 못한 건 일괄 승인에서 제외한다. 개별로 확인해야 한다.
    .eq('qc_passed', true);

  revalidatePath('/');
}
