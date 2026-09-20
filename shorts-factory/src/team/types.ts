import type { AudienceProfile } from '../lib/audience.js';
import type { ChannelConfig } from '../config.js';

/**
 * 팀 계약.
 *
 * 파이프라인을 하나의 긴 스크립트로 두지 않고, 전문성 하나씩을 맡는 담당자들이
 * 작업물을 넘겨가며 완성하는 구조로 본다. 실질적인 이득은 세 가지다:
 *
 *   1. 각 담당자가 자기 영역의 판단 기준만 알면 된다 (프롬프트가 짧고 정확해진다)
 *   2. 자기 결과물을 자기가 검수한다 — 불량이 다음 공정으로 안 넘어간다
 *   3. 인수인계 메모가 남아서, 결과물이 왜 이렇게 나왔는지 역추적된다
 */

/** 작업 지시서. 담당자를 거칠 때마다 내용이 채워진다. */
/** 후보 한 건. 고른 상품과 그걸 찾은 원본 영상을 함께 들고 다닌다. */
export interface ProductCandidate {
  productNameKo: string;
  keywordsZh: string[];
  keywordEn: string;
  priceKrw: number | null;
  rationale: string;
  source: {
    url: string;
    videoId: string;
    caption: string;
    views: number | null;
    likes: number | null;
    /** 어디서 찾았는지. references.platform 에 그대로 들어간다. */
    platform: string;
  };
}

export interface Brief {
  runId: string;
  /** 이 건을 올릴 채널 */
  channel: ChannelConfig;
  audience: AudienceProfile;

  /** 소싱 담당이 채운다 */
  product?: {
    id: string;
    titleKo: string;
    /** 중국어 검색어 후보들. 한 번에 안 걸리므로 변형을 여러 개 준비한다. */
    keywordsZh: string[];
    keywordEn?: string;
    priceKrw: number | null;
    /** 왜 이 상품인가 */
    rationale: string;
  };

  /**
   * "이 제품으로 만들어라" — 발굴을 건너뛰고 이미 DB 에 있는 상품으로 간다.
   *
   * 소재를 사람이 수확하게 되면서 필요해졌다. 수확은 **특정 상품의 검색어**에
   * 묶여 있는데, 소싱 담당은 매 실행마다 인스타에서 새 상품을 고른다. 그대로
   * 두면 어제 무선 물총 소재를 모아와도 오늘 실행은 헤어 고데기를 골라서
   * 수확물이 영영 안 쓰인다.
   *
   * 값은 products.title_ko 또는 title_zh 의 일부다. 정확히 하나만 맞아야 한다 —
   * 여러 개가 맞으면 무엇을 고를지 추측하지 않고 던진다.
   */
  pinnedProduct?: string;

  /**
   * 소싱 담당이 남겨둔 다음 후보들.
   *
   * 아래 담당자가 퇴짜를 놓으면(예: 한국에서 안 파는 물건) 발굴을 처음부터 다시
   * 하지 않고 여기서 다음 걸 꺼낸다. 인스타 탐색은 한 번에 2분 반이 걸려서,
   * 후보 하나가 떨어질 때마다 다시 긁으면 재시도가 사실상 불가능해진다.
   */
  shortlist?: ProductCandidate[];

  /**
   * 아래에서 퇴짜 맞은 상품들. 소싱 담당이 다시 고를 때 제외 목록으로 넘긴다.
   *
   * 이유까지 적는 건 LLM 에게 "왜 떨어졌는지" 를 보여주기 위해서다. 이름만
   * 빼면 같은 종류를 또 고른다.
   */
  rejected?: { titleKo: string; by: string; reason: string }[];

  /** 소싱 담당이 찾은 검증된 레퍼런스 */
  reference?: {
    id: string;
    url: string;
    platform: string;
    views: number | null;
    caption: string;
    /** 팔로워 대비 배수 또는 절대 조회수 기반 점수 */
    outlierScore: number;
  };

  /**
   * 제휴 담당이 확정한 판매처.
   *
   * 이게 비어 있으면 그 제품은 한국에서 살 데가 없다는 뜻이고, 영상을 만들어도
   * 수익이 0이다. 그래서 소재를 구하기 **전에** 채워져야 한다.
   */
  offer?: {
    merchantKey: string;
    merchantLabel: string;
    /** 쇼핑몰 상품 페이지. 제휴 링크가 아니다. */
    productUrl: string;
    productTitle: string;
    priceKrw: number | null;
    rocket: boolean;
    commissionRate: number | null;
    cookieDays: number | null;
    /** 수수료율 × 기여도기간 */
    score: number;
    /**
     * 제휴 링크를 아직 못 만든 상태인가.
     *
     * 쿠팡 파트너스 API 키는 최종승인된 회원만 받는다(실측: 생성 버튼 disabled).
     * 키가 없으면 링크 부착이 수동이고, 그 사실을 여기 들고 다녀야 유통 담당이
     * 링크 없이 올려버리는 일이 없다.
     */
    needsManualLink: boolean;
  };

  /** 소재 담당이 확보한 해외 원본 */
  footage?: {
    assetIds: string[];
    localPaths: string[];
    sourceUrls: string[];
    triedKeywords: string[];
    /**
     * 이번에 쓴 수확 소재 행들.
     *
     * "썼다" 표시는 **영상이 실제로 나온 뒤에** 찍는다. 다운로드 직후에 찍었더니,
     * 뒤 단계에서 죽은 실행이 사람이 20분 들여 모아온 재고를 통째로 태웠다
     * (19차가 ⑥ 성우에서 죽으면서 12개를 전부 소진시켰다).
     */
    harvestedLinkIds: string[];
  };

  /** 구조 분석가의 산출물 */
  blueprint?: {
    id: string;
    hookType: string;
    /**
     * action 은 편집자가 "같은 동작이 찍힌 소재" 를 고르는 데 쓴다.
     * 여기가 성기면("제품 등장") 전혀 다른 영상이 나온다.
     */
    cuts: {
      t: [number, number];
      shot: string;
      action: string;
      framing: string;
      purpose: string;
    }[];
    /** 무엇을 주장했고 화면으로 어떻게 증명했는가. 카피라이터가 그 주장을 한국어로 다시 쓴다. */
    appeals: { point: string; shown_as: string }[];
  };

  /** 카피라이터의 산출물 */
  script?: {
    id: string;
    lines: { idx: number; text: string; cutIndex: number }[];
    cta: string;
  };

  /** 성우 연출의 산출물 */
  narration?: {
    id: string;
    lineDurations: number[];
    totalDurationSec: number;
    audioPath: string;
  };

  /** 편집자의 산출물 */
  render?: {
    id: string;
    storagePath: string;
    durationSec: number;
  };

  /** 담당자들이 남긴 인수인계 메모 */
  notes: HandoffNote[];
}

export interface HandoffNote {
  from: string;
  /** 다음 담당자가 알아야 할 것 */
  message: string;
  /** 판단이 갈릴 수 있었던 지점 */
  caveat?: string;
  at: string;
}

export interface ReviewResult {
  ok: boolean;
  /** 통과하지 못한 이유. 비어 있으면 통과. */
  problems: string[];
  /** 통과는 했지만 다음 담당자가 알아야 할 것 */
  warnings: string[];
}

export const PASS: ReviewResult = { ok: true, problems: [], warnings: [] };

export function fail(...problems: string[]): ReviewResult {
  return { ok: false, problems, warnings: [] };
}

/**
 * 담당자 한 명.
 *
 * `charter` 는 이 담당자가 LLM을 호출할 때 시스템 프롬프트로 들어간다.
 * 사람 직원에게 주는 업무 지침과 같은 역할이라, 여기에 적힌 판단 기준이
 * 그대로 결과물의 성격이 된다.
 */
export interface TeamMember {
  /** 코드에서 참조할 식별자 */
  id: string;
  /** 사람이 읽는 직함 */
  role: string;
  /** 한 줄 전문 분야 */
  expertise: string;
  /** 업무 헌장 — LLM 시스템 프롬프트 */
  charter: string;
  /** 자기 담당 구간을 수행하고 지시서를 채워서 돌려준다 */
  work(brief: Brief): Promise<Brief>;
  /** 자기 결과물을 자기가 검수한다. 불합격이면 다음 공정으로 안 넘어간다. */
  review(brief: Brief): Promise<ReviewResult>;
}

export function note(from: string, message: string, caveat?: string): HandoffNote {
  return { from, message, ...(caveat ? { caveat } : {}), at: new Date().toISOString() };
}

/** 지시서에 메모를 붙여 돌려준다. */
export function withNote(brief: Brief, from: string, message: string, caveat?: string): Brief {
  return { ...brief, notes: [...brief.notes, note(from, message, caveat)] };
}

/** 담당자가 자기 구간을 못 끝냈을 때. 이 건만 중단되고 나머지 슬롯은 계속 간다. */
export class HandoffError extends Error {
  constructor(
    public readonly member: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(`[${member}] ${message}`);
    this.name = 'HandoffError';
  }
}
