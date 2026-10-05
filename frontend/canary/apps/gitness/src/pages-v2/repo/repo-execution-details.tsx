import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import {
  LivelogLine,
  TypesStage,
  TypesStep,
  useFindExecutionQuery,
  useViewLogsQuery
} from '@harnessio/code-service-client'
import { Layout } from '@harnessio/ui/components'
import {
  convertExecutionToTree,
  ExecutionState,
  ExecutionTree,
  getStepId,
  mapCiStatusToExecutionState,
  NodeSelectionProps,
  parseStageStepId,
  StepExecution
} from '@harnessio/views'

import { useGetRepoRef } from '../../framework/hooks/useGetRepoPath'
import { useLogs } from '../../framework/hooks/useLogs'
import { PathParams } from '../../RouteDefinitions'

// Execution detail: stage/step tree on the left, console log for the
// selected step on the right. Buffered logs come from the view-logs
// endpoint; while a step is RUNNING the `useLogs` SSE hook streams more.
export default function RepoExecutionDetailsPage() {
  const repoRef = useGetRepoRef()
  const { pipelineId, executionId } = useParams<PathParams>()
  const [selectedId, setSelectedId] = useState<string>('')
  const [streamedLogs, setStreamedLogs] = useState<LivelogLine[]>([])

  const { data: { body: execution } = {}, isLoading } = useFindExecutionQuery(
    {
      repo_ref: repoRef,
      pipeline_identifier: pipelineId ?? '',
      execution_number: executionId ?? ''
    },
    { enabled: !!repoRef && !!pipelineId && !!executionId, refetchInterval: 5000 }
  )

  const treeElements = useMemo(
    () => convertExecutionToTree({ stages: (execution?.stages ?? []) as never }),
    [execution]
  )

  // Default-select the first step once the tree resolves.
  useEffect(() => {
    if (selectedId || !treeElements.length) return
    const firstStage = execution?.stages?.[0]
    const firstStep = firstStage?.steps?.[0]
    if (firstStage?.number && firstStep?.number) {
      setSelectedId(getStepId(firstStage.number, firstStep.number))
    }
  }, [treeElements, selectedId, execution])

  const selection = useMemo(() => {
    const parsed = selectedId ? parseStageStepId(selectedId) : undefined
    if (!parsed) return { stage: undefined as TypesStage | undefined, step: undefined as TypesStep | undefined }
    const stage = execution?.stages?.find(s => s.number === parseInt(parsed.stageId, 10))
    const step = parsed.stepId
      ? stage?.steps?.find(s => s.number === parseInt(parsed.stepId as string, 10))
      : stage?.steps?.[0]
    return { stage, step }
  }, [selectedId, execution])

  const stepNum = selection.step?.number ?? 0
  const stageNum = selection.stage?.number ?? 0
  const stepStatus = selection.step?.status
    ? mapCiStatusToExecutionState(selection.step.status)
    : ExecutionState.PENDING

  const { data: { body: bufferedLogs } = {} } = useViewLogsQuery(
    {
      repo_ref: repoRef,
      pipeline_identifier: pipelineId ?? '',
      execution_number: executionId ?? '',
      stage_number: String(stageNum),
      step_number: String(stepNum)
    },
    { enabled: !!repoRef && !!pipelineId && !!executionId && stageNum > 0 && stepNum > 0 }
  )

  const { logs: liveLogs } = useLogs({
    repoPath: repoRef,
    pipelineId: pipelineId ?? '',
    executionNum: executionId ?? '',
    stageNum,
    stepNum,
    stepStatus
  })

  const logs = useMemo<LivelogLine[]>(() => {
    const merged = new Map<number, LivelogLine>()
    for (const l of bufferedLogs ?? []) if (l.pos != null) merged.set(l.pos, l)
    for (const l of liveLogs ?? []) if (l.pos != null) merged.set(l.pos, l)
    return [...merged.values()].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))
  }, [bufferedLogs, liveLogs])

  useEffect(() => {
    setStreamedLogs(logs)
  }, [logs])

  const onSelectNode = useCallback(({ childNode }: NodeSelectionProps) => {
    if (childNode?.id) setSelectedId(childNode.id)
  }, [])

  if (isLoading && !execution) {
    return <Layout.Flex className="p-cn-xl">Loading execution…</Layout.Flex>
  }
  if (!execution) {
    return <Layout.Flex className="p-cn-xl">Execution not found</Layout.Flex>
  }

  return (
    <Layout.Flex className="h-full">
      <div className="w-72 shrink-0 border-r">
        <ExecutionTree defaultSelectedId={selectedId} elements={treeElements} onSelectNode={onSelectNode} />
      </div>
      <div className="flex-1 min-w-0">
        <StepExecution
          step={selection.step as never}
          logs={streamedLogs}
          onEdit={() => {}}
          onDownload={() => {
            const blob = new Blob([streamedLogs.map(l => l.out ?? '').join('\n')], {
              type: 'text/plain'
            })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `execution-${executionId}-stage${stageNum}-step${stepNum}.log`
            a.click()
            URL.revokeObjectURL(a.href)
          }}
          onCopy={() => navigator.clipboard.writeText(streamedLogs.map(l => l.out ?? '').join('\n'))}
        />
      </div>
    </Layout.Flex>
  )
}
