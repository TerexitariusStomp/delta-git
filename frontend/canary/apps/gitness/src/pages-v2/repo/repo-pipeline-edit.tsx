import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { noop } from 'lodash-es'

import {
  useCommitFilesMutation,
  useCreateExecutionMutation,
  useFindPipelineQuery
} from '@harnessio/code-service-client'
import { Layout } from '@harnessio/ui/components'
import {
  ITemplateListStore,
  RUN_STEP_DESCRIPTION,
  RUN_STEP_IDENTIFIER,
  runStepFormDefinition,
  UnifiedPipelineStudio,
  VisualYamlValue,
  YamlErrorDataType
} from '@harnessio/views'
import type { YamlRevision } from '@harnessio/yaml-editor'

import { useAPIPath } from '../../hooks/useAPIPath'
import { useGetRepoRef } from '../../framework/hooks/useGetRepoPath'
import { PathParams } from '../../RouteDefinitions'

// Templates are not part of the delta-git CI surface yet — the studio
// renders the same pipeline without them.
const useEmptyTemplateListStore = (): ITemplateListStore => ({
  templates: [],
  setTemplatesData: noop,
  page: 1,
  setPage: noop,
  totalItems: 0,
  pageSize: 10,
  searchQuery: '',
  setSearchQuery: noop,
  getTemplateFormDefinition: async () => ({ inputs: [] }),
  isLoading: false
})

const defaultErrors: YamlErrorDataType = {
  problems: [],
  problemsCount: { error: 0, warning: 0, info: 0, all: 0 },
  isYamlValid: true
}

// Pipeline edit: the vendored UnifiedPipelineStudio gives a visual graph +
// monaco YAML editor over the pipeline's config_path blob. Save commits the
// yaml via the commit-files endpoint; Run spawns a manual execution.
export default function RepoPipelineEditPage() {
  const repoRef = useGetRepoRef()
  const apiPath = useAPIPath()
  const navigate = useNavigate()
  const { pipelineId } = useParams<PathParams>()

  const [view, setView] = useState<VisualYamlValue>('yaml')
  const [yamlRevision, setYamlRevision] = useState<YamlRevision>({ yaml: '', revisionId: 0 })
  const [errors, setErrors] = useState<YamlErrorDataType>(defaultErrors)
  const [panelOpen, setPanelOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isYamlDirty, setIsYamlDirty] = useState(false)
  const loadedRef = useRef(false)

  const { data: { body: pipeline } = {} } = useFindPipelineQuery(
    { repo_ref: repoRef, pipeline_identifier: pipelineId ?? '' },
    { enabled: !!repoRef && !!pipelineId }
  )

  const configPath = pipeline?.config_path || '.delta/pipeline.yaml'
  const defaultBranch = pipeline?.default_branch || 'main'

  // The `view` endpoint is a delta-git extension — no generated hook exists.
  useEffect(() => {
    if (!repoRef || !pipelineId || loadedRef.current) return
    loadedRef.current = true
    fetch(apiPath(`/api/v1/repos/${repoRef}/pipelines/${pipelineId}/view`), { credentials: 'include' })
      .then(async res => {
        if (!res.ok) return
        const body = (await res.json()) as { yaml?: string }
        if (typeof body.yaml === 'string') {
          setYamlRevision({ yaml: body.yaml, revisionId: 1 })
        }
      })
      .catch(noop)
      .finally(() => setLoading(false))
  }, [repoRef, pipelineId, apiPath])

  const onYamlRevisionChange = useCallback((revision: YamlRevision) => {
    setYamlRevision(revision)
    setIsYamlDirty(true)
    setSaveError(null)
  }, [])

  const onYamlDownload = useCallback((yaml: string) => {
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'pipeline.yaml'
    anchor.click()
    URL.revokeObjectURL(url)
  }, [])

  const { mutateAsync: commitFiles, isLoading: saving } = useCommitFilesMutation({})
  const { mutateAsync: createExecution, isLoading: running } = useCreateExecutionMutation({})

  const onSave = useCallback(
    async (yaml: string) => {
      setSaveError(null)
      try {
        await commitFiles({
          repo_ref: repoRef,
          body: {
            branch: defaultBranch,
            title: `Update pipeline ${pipelineId}`,
            actions: [
              {
                action: 'UPDATE',
                path: configPath,
                payload: yaml,
                encoding: 'utf8'
              }
            ]
          }
        })
        setIsYamlDirty(false)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to save pipeline')
      }
    },
    [commitFiles, repoRef, defaultBranch, configPath, pipelineId]
  )

  const onRun = useCallback(() => {
    createExecution({
      repo_ref: repoRef,
      pipeline_identifier: pipelineId ?? '',
      queryParams: { branch: defaultBranch }
    })
      .then(({ body }) => {
        if (body?.number) {
          navigate(`../executions/${body.number}`)
        }
      })
      .catch(noop)
  }, [createExecution, repoRef, pipelineId, defaultBranch, navigate])

  return (
    <Layout.Vertical className="flex-1">
      {saveError ? <div className="px-5 pt-2 text-cn-danger">{saveError}</div> : null}
      <UnifiedPipelineStudio
        view={view}
        setView={setView}
        useTemplateListStore={useEmptyTemplateListStore}
        yamlRevision={yamlRevision}
        onYamlRevisionChange={onYamlRevisionChange}
        onYamlDownload={onYamlDownload}
        onSave={onSave}
        onRun={onRun}
        isYamlDirty={isYamlDirty}
        saveInProgress={saving || running}
        loadInProgress={loading}
        stepsDefinitions={[
          {
            identifier: RUN_STEP_IDENTIFIER,
            description: RUN_STEP_DESCRIPTION,
            formDefinition: runStepFormDefinition
          }
        ]}
        errors={errors}
        onErrorsChange={setErrors}
        panelOpen={panelOpen}
        onPanelOpenChange={setPanelOpen}
        onSelectedPathChange={noop}
      />
    </Layout.Vertical>
  )
}
