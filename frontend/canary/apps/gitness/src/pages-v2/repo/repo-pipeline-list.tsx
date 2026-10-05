import { useEffect, useState } from 'react'

import { create } from 'zustand'

import {
  useCreatePipelineMutation,
  useListPipelinesQuery
} from '@harnessio/code-service-client'
import {
  CreatePipelineDialog,
  CreatePipelineFormType,
  ICreatePipelineStore,
  PipelineListPage
} from '@harnessio/views'

import { useGetRepoRef } from '../../framework/hooks/useGetRepoPath'
import { parseAsInteger, useQueryState } from '../../framework/hooks/useQueryState'
import { PageResponseHeader } from '../../types'
import { usePipelineListStore } from './stores/repo-pipeline-list-store'
import { apiPipelines2Pipelines } from './transform-utils/pipeline-list-transform'

const useCreatePipelineStore = create<ICreatePipelineStore>(set => ({
  setBranchesState: payload => set(payload),
  setError: error => set({ error })
}))

export default function RepoPipelineListPage() {
  const repoRef = useGetRepoRef()

  const [query, setQuery] = useQueryState('query')
  const [queryPage, setQueryPage] = useQueryState('page', parseAsInteger.withDefault(1))
  const [isCreateOpen, setIsCreateOpen] = useState(false)

  const { setPipelinesData, page, setPage, pageSize } = usePipelineListStore()
  const { setError } = useCreatePipelineStore()

  const {
    data: { body: pipelinesBody, headers } = {},
    isFetching,
    isError,
    error,
    refetch
  } = useListPipelinesQuery(
    {
      repo_ref: repoRef,
      queryParams: { page, limit: pageSize || 30, query: query ?? undefined }
    },
    { enabled: !!repoRef }
  )

  const { mutate: createPipeline, isLoading: isCreating } = useCreatePipelineMutation(
    { repo_ref: repoRef },
    {
      onSuccess: () => {
        setIsCreateOpen(false)
        refetch()
      },
      onError: e => setError({ message: (e as { message?: string }).message ?? 'pipeline create failed' })
    }
  )

  useEffect(() => {
    if (pipelinesBody) {
      const pipelines = apiPipelines2Pipelines(pipelinesBody)
      const totalItems = parseInt(headers?.get(PageResponseHeader.xTotal) || '0')
      const pageSizeFromHeader = parseInt(headers?.get(PageResponseHeader.xPerPage) || String(pageSize))
      setPipelinesData(pipelines, { totalItems, pageSize: pageSizeFromHeader })
    } else {
      setPipelinesData(null, { totalItems: 0, pageSize })
    }
  }, [pipelinesBody, headers])

  useEffect(() => {
    setQueryPage(page)
  }, [queryPage, page, setPage])

  const onSubmit = async (formValues: CreatePipelineFormType) => {
    setError(undefined)
    createPipeline({
      body: {
        identifier: formValues.name,
        config_path: formValues.yamlPath,
        // delta-git extension — `on_push` pipelines spawn executions on every
        // matching ref update (the create dialog has no trigger UI).
        on_push: true,
        default_branch: formValues.branch
      }
    } as never)
  }

  return (
    <>
      <PipelineListPage
        usePipelineListStore={usePipelineListStore}
        isLoading={isFetching || isCreating}
        isError={isError}
        errorMessage={error?.message}
        searchQuery={query}
        setSearchQuery={setQuery}
        handleCreatePipeline={() => setIsCreateOpen(true)}
        toPipelineDetails={pipeline => `./${pipeline.id}`}
      />
      <CreatePipelineDialog
        useCreatePipelineStore={useCreatePipelineStore}
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCancel={() => setIsCreateOpen(false)}
        onSubmit={onSubmit}
      />
    </>
  )
}
