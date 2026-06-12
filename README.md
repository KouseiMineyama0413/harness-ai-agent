# dev-harness

あらゆるアプリケーション開発(Web / API / SaaS / CLI / AIアプリ / 業務システム)で共通利用できる、フレームワーク非依存の **development harness** です。要件定義 → 設計 → 実装 → テスト → レビュー → CI までの開発ループに、**品質ゲート**と **AIエージェント向けガードレール**を提供します。

## 設計思想

1. **Harness は実行者ではなく「枠組み」** — コードを書くのは人間か AI エージェント。harness はその周囲に検証可能な構造(プロファイル、ゲート、予算、レポート)を張る。
2. **すべての知識はファイルに残す** — スタック検出結果は `project_profile.json`、実行結果は `.harness/reports/`、要件は `.harness/requirements/`。Git にコミットでき、人間がレビューできる。
3. **推定はするが、設定が常に勝つ** — テスト/ビルドコマンドは自動推定するが、`harness.yaml` の明示設定が最優先。`command: null` で無効化も可能。
4. **スタック知識は Adapter に隔離** — コアは「言語」を知らない。Node/Python/Go/infra の知識はそれぞれのアダプタにあり、追加=1ファイル追加。
5. **エージェントは信頼しない** — 変更予算(ファイル数・行数)、保護パス、危険コマンドポリシー、secret 検出を機械的に強制する。

## インストール

要件: **Node.js >= 22.5**(組み込みの `node:sqlite` を使用。ネイティブ依存はありません。22.5–22.12 では `--experimental-sqlite` フラグが必要な場合があります)

```bash
# 既存リポジトリで(リポジトリ自体には依存を追加しない)
pnpm add -g @peakcode/dev-harness   # または pnpm dlx で都度実行
cd your-project
harness init        # harness.yaml と .harness/ を生成
harness analyze     # スタック検出 → .harness/project_profile.json
harness context     # AIエージェント用コンテキスト生成
harness gate run    # 品質ゲート実行 → .harness/reports/
```

## CLI

| コマンド | 説明 |
|---|---|
| `harness init` | `harness.yaml` と `.harness/` 雛形を生成 |
| `harness analyze [--json]` | 技術スタック検出、`project_profile.json` を生成 |
| `harness context [--print]` | AI エージェント向け構造化コンテキスト(`context.json` / `context.md`)生成 |
| `harness gate run [--only lint,test]` | 品質ゲート実行。失敗時 exit 1。レポートを `.harness/reports/` に保存 |
| `harness guard check-command "<cmd>"` | コマンドを安全ポリシーで判定(allow / confirm / deny) |
| `harness guard scan-diff [--base origin/main]` | 変更予算・保護パス・secret 混入を diff 検査 |
| `harness req new "<title>"` | 構造化要件(acceptance criteria / NFR 付き)の雛形作成 |
| `harness req lint <REQ-id>` | 曖昧表現・受け入れ基準欠落の検出 |
| `harness session start "<task>" --agent claude` | エージェント共有セッション開始 |
| `harness session prompt/note/decision "<text>"` | セッションへイベント記録(prompt は履歴にも保存) |
| `harness session handoff --agent codex` | 次のエージェント向け引き継ぎドキュメント生成 |
| `harness session list / show / end` | セッション管理 |
| `harness history [--limit 50] [--search <q> [--agent X]]` | prompt 履歴の閲覧・検索(SQLite) |
| `harness team list` | 観測されたエージェント一覧 |
| `harness team activity [--agent X]` | エージェント別アクティビティ集計(コスト含む・SQLite) |
| `harness team sessions <agent>` | エージェントが参加したセッション一覧 |
| `harness reindex` | SQLite インデックスをファイルから再構築 |
| `harness claim add/release/release-all/list` | パスの排他 claim(並行エージェントの衝突防止) |
| `harness plan new/approve/reject/complete/list/show` | 実装計画の作成と人間による承認 |
| `harness session cost --usd 0.42 --tokens-in N` | セッションへのコスト記録 |
| `harness session summarize [id]` | LLM でセッションを要約し、教訓を project profile に蓄積 |
| `harness gate run --changed [base]` | 変更ファイルに関連するテスト/lint のみ実行 |
| `harness pr-summary [--base ref] [--out f]` | セッションの decision・diff・gate 結果から PR 説明文を生成 |
| `harness doctor` | 環境診断(node / sqlite / git / 設定 / 統合) |
| `harness integrate git-hooks` | pre-commit(scan-diff)/ pre-push(gate run)を設置 |
| `harness mcp` | MCP サーバーとして起動(エージェントがネイティブツールとして利用) |
| `harness integrate claude\|codex` | エージェント統合のインストール(hook / AGENTS.md) |
| `harness report list` | 生成済みレポート一覧 |

終了コード: `0` 成功 / `1` チェック失敗 / `2` 設定・使用方法エラー。stdout は機械可読出力、進捗等は stderr。

## 品質ゲート

`lint` / `typecheck` / `test` / `build` / `security` / `deps` / `coverage` の 7 種。コマンド解決順:

1. `harness.yaml` の `gates.<id>.command`(`null` なら無効化)
2. アダプタの自動推定(例: package.json の scripts、`go test ./...`、`pytest`)
3. どちらも無ければ skip(理由付き)

`security` / `deps` / `coverage` はデフォルト advisory(失敗しても全体は落とさない)。`required: true` で昇格できます。

## セッション共有と prompt 履歴(Claude ⇄ Codex)

複数のエージェントが**同じセッションをファイル経由で共有**します。状態はすべて `.harness/` 配下のプレーンファイルなので、リポジトリを読めるツールなら何でも参加できます。

```
.harness/sessions/S-001.json           # セッションメタ(参加エージェント、状態)
.harness/sessions/S-001.events.jsonl   # 追記専用イベントログ(prompt/note/decision/handoff)
.harness/sessions/S-001.handoff.md     # 引き継ぎドキュメント
.harness/prompt_history.jsonl          # prompt 履歴(セッション横断・デフォルト有効)
```

典型フロー — Claude が作業を始め、Codex が引き継ぐ:

```bash
# Claude 側
harness session start "CSVエクスポート実装" --agent claude
harness session decision "ストリーミング書き出しにする" --agent claude
harness session handoff --agent claude        # 引き継ぎ文書を生成

# Codex 側(同じリポジトリで)
harness context                               # context.md にアクティブセッションと直近イベントが載る
harness session note "テストから再開" --agent codex   # 自動的に同じセッションに参加
```

- **prompt 履歴はデフォルトで残ります**(`session.promptHistory: true`)。セッションが無くても `harness session prompt` は `.harness/prompt_history.jsonl` に記録され、`harness history` で閲覧できます。
- 保存前にすべてのテキストへ **secret 赤塗り**を適用するため、履歴経由で認証情報が漏れません。
- `harness integrate claude` を実行すると Claude Code の **UserPromptSubmit hook** が `.claude/settings.json` に設定され、prompt が**自動で**記録されます(hook は常に exit 0 で、ユーザー操作を妨げません)。
- Codex には prompt hook が無いため、`harness integrate codex` が **AGENTS.md** に運用ルール(prompt 記録・decision 記録・handoff)を追記し、Codex がそれに従います。

## エージェントチーム管理と SQLite インデックス

「team」= **このリポジトリで働くエージェントたち(claude / codex / human / …)** です。各エージェントのセッション・prompt・decision を SQLite で横断クエリできます。

**正本は git 管理のプレーンファイル、SQLite はそこから再構築可能なクエリ用インデックス**というハイブリッド構成です(`.harness/cache/harness.db`、git-ignore)。

```bash
$ harness team activity
agent   sessions  prompts  decisions  notes  last active
codex   2         1        0          1      2026-06-12T04:32:41Z
claude  1         1        1          0      2026-06-12T04:32:41Z

$ harness team sessions codex
session  status  title              events  last event
S-001    closed  CSVエクスポート実装   1       2026-06-12T04:32:41Z
S-002    active  ページネーション      3       2026-06-12T05:01:02Z

$ harness history --search "CSV" --agent claude
[...] claude (S-001): 注文履歴をCSVで出せるようにして
```

- `harness team list` — イベント/prompt 履歴に現れたエージェントの一覧
- `harness team activity` — エージェント別のセッション数・prompt数・decision数・最終活動
- `harness team sessions <agent>` — そのエージェントが参加した全セッションとイベント数
- `harness history --search <q> [--agent X]` — prompt 履歴の部分一致検索(日本語対応)
- インデックスはクエリ実行時に毎回ファイルから自動再構築されるため、**DB が壊れても消しても情報は失われません**(明示再構築: `harness reindex`)

SQLite は Node.js 組み込みの `node:sqlite` を使うため、`better-sqlite3` のようなネイティブビルドは不要です。

## 並行エージェントの衝突防止(claim)

```bash
harness claim add src/billing --agent claude --reason "請求リファクタ中"
# 別エージェントが重なる claim を取ろうとすると即エラー。
# さらに guard scan-diff が「他エージェントの claim 下のファイルへの変更」を violation にする
harness guard scan-diff --agent codex   # → VIOLATIONS: claimed by claude
```

claim は `.harness/claims.json`(コミット対象)に保存。`harness doctor` が 24h 超の放置 claim を警告します。

## 計画の強制(plan)

`harness plan new` でエージェントが計画を作成 → 人間が `harness plan approve PLAN-001 --by <name>` で承認。`agent.enforcePlan: true` にすると、**承認済み plan が無い限り `guard scan-diff` が fail** します(デフォルト off なので既存導入を壊しません)。状態遷移は draft → approved → completed / rejected。

## MCP サーバー

`harness mcp` で stdio の MCP サーバーとして起動します。Claude Code への登録例:

```bash
claude mcp add harness -- harness mcp
```

公開ツール: `get_context` / `run_gates` / `check_command` / `scan_diff` / `record_event` / `search_history` / `team_activity` / `claim_paths` / `write_handoff`。エージェントはシェル経由ではなくネイティブのツール呼び出しで harness を使えます。

## セッション要約(LLM)

`harness session summarize` がセッションのイベントログを Anthropic API(公式 SDK、デフォルト `claude-opus-4-8`)で要約し、`<id>.summary.md` に保存、教訓を `project_profile.json` の notes に追記します(→ 次回以降の `harness context` に自動掲載)。`ANTHROPIC_API_KEY` が必要。プロバイダは `LlmProvider` インターフェースで差し替え可能です。

## AI エージェント連携

エージェントには `.harness/context.md` をプロンプト先頭に渡してください。技術スタック、レイアウト、実行コマンド、そして**遵守必須のガードレール**(変更予算、保護パス、計画必須、secret 禁止)が含まれます。

エージェント側の標準ループ:

```
harness context              # 1. コンテキスト取得
harness req lint REQ-00x     # 2. 要件の曖昧さ確認
(計画を提示し承認を得る)        # 3. requirePlan
(実装)
harness guard check-command  # 4. 危険コマンドは実行前に判定
harness guard scan-diff      # 5. 変更が予算内か検査
harness gate run             # 6. 品質ゲート
(レポートを添えて diff summary を報告)
```

## 設定 (`harness.yaml`)

`harness init` が生成する雛形にすべての項目とコメントがあります。主要部:

```yaml
version: 1
project: { name: my-app }
agent:
  requirePlan: true
  changeBudget: { maxFiles: 20, maxLinesAdded: 800, maxLinesDeleted: 400 }
  protectedPaths: [.github/, infra/]
gates:
  test: { command: npm test -- --ci, required: true }
  coverage: { command: npx vitest run --coverage, threshold: 80, required: false }
context:
  rules: ["DB スキーマ変更は必ず migration で行う"]
```

## CI 連携

`templates/github-actions-harness.yml` を対象リポジトリの `.github/workflows/harness.yml` にコピーしてください。PR ごとに `guard scan-diff` + `gate run` を実行し、レポートを artifact 保存・PR コメント投稿します。GitLab CI / CircleCI も同じ CLI を呼ぶだけで対応できます。

## ディレクトリ構成

```
src/
  cli.ts                 # CLI(commander)。コアの薄いラッパ
  index.ts               # プログラマブル API(embed 用)
  types.ts               # 共有ドメイン型
  config/                # harness.yaml スキーマ(zod)とローダー
  adapters/              # スタック別アダプタ(node/python/go/infra)+ registry
  analyze/               # プロファイル生成(.harness/project_profile.json)
  gates/                 # 品質ゲート解決・実行
  guardrails/            # コマンドポリシー / secret 検出 / diff 予算
  context/               # エージェント向け構造化コンテキスト生成
  report/                # Markdown/JSON レポート
  requirements/          # 構造化要件と曖昧さ linter
templates/               # CI テンプレート
```

## 拡張

- **新しいスタック**: `StackAdapter` を実装し `registerAdapter()`(`src/adapters/registry.ts`)。コア変更不要。
- **プラグイン(将来)**: `harness.yaml` の `plugins:` から外部アダプタを動的ロード。
- **LLM Provider Adapter(将来)**: `context.json` は provider 非依存の中間表現。各 provider 向けプロンプト整形を adapter 化。
- **追加ゲート**: `GateId` を拡張し、`defaultRequired` とアダプタ推定を追加。

## 開発

```bash
pnpm install
pnpm test          # vitest
pnpm run build     # tsc → dist/
pnpm run dev -- analyze   # ソースから直接実行
```

Node のバージョンは `mise.toml` で 22 系に固定されています(`mise install` で揃います)。
