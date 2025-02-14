/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { User } from '../auth/user';
import { Query } from '../core/query';
import { SnapshotVersion } from '../core/snapshot_version';
import { BatchId, ProtoByteString, TargetId } from '../core/types';
import {
  DocumentKeySet,
  documentKeySet,
  DocumentMap,
  maybeDocumentMap,
  MaybeDocumentMap
} from '../model/collections';
import { MaybeDocument, NoDocument } from '../model/document';
import { DocumentKey } from '../model/document_key';
import { Mutation, PatchMutation, Precondition } from '../model/mutation';
import {
  BATCHID_UNKNOWN,
  MutationBatch,
  MutationBatchResult
} from '../model/mutation_batch';
import { RemoteEvent, TargetChange } from '../remote/remote_event';
import { assert } from '../util/assert';
import * as log from '../util/log';
import * as objUtils from '../util/obj';
import { ObjectMap } from '../util/obj_map';

import { LocalDocumentsView } from './local_documents_view';
import { LocalViewChanges } from './local_view_changes';
import { LruGarbageCollector, LruResults } from './lru_garbage_collector';
import { MutationQueue } from './mutation_queue';
import { Persistence, PersistenceTransaction } from './persistence';
import { PersistencePromise } from './persistence_promise';
import { QueryCache } from './query_cache';
import { QueryData, QueryPurpose } from './query_data';
import { QueryEngine } from './query_engine';
import { ReferenceSet } from './reference_set';
import { RemoteDocumentCache } from './remote_document_cache';
import { RemoteDocumentChangeBuffer } from './remote_document_change_buffer';
import { ClientId } from './shared_client_state';

const LOG_TAG = 'LocalStore';

/** The result of a write to the local store. */
export interface LocalWriteResult {
  batchId: BatchId;
  changes: MaybeDocumentMap;
}

/** The result of a user-change operation in the local store. */
export interface UserChangeResult {
  readonly affectedDocuments: MaybeDocumentMap;
  readonly removedBatchIds: BatchId[];
  readonly addedBatchIds: BatchId[];
}

/** The result of executing a query against the local store. */
export interface QueryResult {
  readonly documents: DocumentMap;
  readonly remoteKeys: DocumentKeySet;
}

/**
 * Local storage in the Firestore client. Coordinates persistence components
 * like the mutation queue and remote document cache to present a
 * latency-compensated view of stored data.
 *
 * The LocalStore is responsible for accepting mutations from the Sync Engine.
 * Writes from the client are put into a queue as provisional Mutations until
 * they are processed by the RemoteStore and confirmed as having been written
 * to the server.
 *
 * The local store provides the local version of documents that have been
 * modified locally. It maintains the constraint:
 *
 *   LocalDocument = RemoteDocument + Active(LocalMutations)
 *
 * (Active mutations are those that are enqueued and have not been previously
 * acknowledged or rejected).
 *
 * The RemoteDocument ("ground truth") state is provided via the
 * applyChangeBatch method. It will be some version of a server-provided
 * document OR will be a server-provided document PLUS acknowledged mutations:
 *
 *   RemoteDocument' = RemoteDocument + Acknowledged(LocalMutations)
 *
 * Note that this "dirty" version of a RemoteDocument will not be identical to a
 * server base version, since it has LocalMutations added to it pending getting
 * an authoritative copy from the server.
 *
 * Since LocalMutations can be rejected by the server, we have to be able to
 * revert a LocalMutation that has already been applied to the LocalDocument
 * (typically done by replaying all remaining LocalMutations to the
 * RemoteDocument to re-apply).
 *
 * The LocalStore is responsible for the garbage collection of the documents it
 * contains. For now, it every doc referenced by a view, the mutation queue, or
 * the RemoteStore.
 *
 * It also maintains the persistence of mapping queries to resume tokens and
 * target ids. It needs to know this data about queries to properly know what
 * docs it would be allowed to garbage collect.
 *
 * The LocalStore must be able to efficiently execute queries against its local
 * cache of the documents, to provide the initial set of results before any
 * remote changes have been received.
 *
 * Note: In TypeScript, most methods return Promises since the implementation
 * may rely on fetching data from IndexedDB which is async.
 * These Promises will only be rejected on an I/O error or other internal
 * (unexpected) failure (e.g. failed assert) and always represent an
 * unrecoverable error (should be caught / reported by the async_queue).
 */
export class LocalStore {
  /**
   * The maximum time to leave a resume token buffered without writing it out.
   * This value is arbitrary: it's long enough to avoid several writes
   * (possibly indefinitely if updates come more frequently than this) but
   * short enough that restarting after crashing will still have a pretty
   * recent resume token.
   */
  private static readonly RESUME_TOKEN_MAX_AGE_MICROS = 5 * 60 * 1e6;

  /**
   * The set of all mutations that have been sent but not yet been applied to
   * the backend.
   */
  private mutationQueue: MutationQueue;

  /** The set of all cached remote documents. */
  private remoteDocuments: RemoteDocumentCache;

  /**
   * The "local" view of all documents (layering mutationQueue on top of
   * remoteDocumentCache).
   */
  private localDocuments: LocalDocumentsView;

  /**
   * The set of document references maintained by any local views.
   */
  private localViewReferences = new ReferenceSet();

  /** Maps a query to the data about that query. */
  private queryCache: QueryCache;

  /** Maps a targetID to data about its query. */
  private queryDataByTarget = {} as { [targetId: number]: QueryData };

  /** Maps a query to its targetID. */
  private targetIdByQuery = new ObjectMap<Query, TargetId>(q =>
    q.canonicalId()
  );

  constructor(
    /** Manages our in-memory or durable persistence. */
    private persistence: Persistence,
    private queryEngine: QueryEngine,
    initialUser: User
  ) {
    assert(
      persistence.started,
      'LocalStore was passed an unstarted persistence implementation'
    );
    this.persistence.referenceDelegate.setInMemoryPins(
      this.localViewReferences
    );
    this.mutationQueue = persistence.getMutationQueue(initialUser);
    this.remoteDocuments = persistence.getRemoteDocumentCache();
    this.queryCache = persistence.getQueryCache();
    this.localDocuments = new LocalDocumentsView(
      this.remoteDocuments,
      this.mutationQueue,
      this.persistence.getIndexManager()
    );
    this.queryEngine.setLocalDocumentsView(this.localDocuments);
  }

  /**
   * Tells the LocalStore that the currently authenticated user has changed.
   *
   * In response the local store switches the mutation queue to the new user and
   * returns any resulting document changes.
   */
  // PORTING NOTE: Android and iOS only return the documents affected by the
  // change.
  handleUserChange(user: User): Promise<UserChangeResult> {
    return this.persistence.runTransaction(
      'Handle user change',
      'readonly',
      txn => {
        // Swap out the mutation queue, grabbing the pending mutation batches
        // before and after.
        let oldBatches: MutationBatch[];
        return this.mutationQueue
          .getAllMutationBatches(txn)
          .next(promisedOldBatches => {
            oldBatches = promisedOldBatches;

            this.mutationQueue = this.persistence.getMutationQueue(user);

            // Recreate our LocalDocumentsView using the new
            // MutationQueue.
            this.localDocuments = new LocalDocumentsView(
              this.remoteDocuments,
              this.mutationQueue,
              this.persistence.getIndexManager()
            );
            this.queryEngine.setLocalDocumentsView(this.localDocuments);
            return this.mutationQueue.getAllMutationBatches(txn);
          })
          .next(newBatches => {
            const removedBatchIds: BatchId[] = [];
            const addedBatchIds: BatchId[] = [];

            // Union the old/new changed keys.
            let changedKeys = documentKeySet();

            for (const batch of oldBatches) {
              removedBatchIds.push(batch.batchId);
              for (const mutation of batch.mutations) {
                changedKeys = changedKeys.add(mutation.key);
              }
            }

            for (const batch of newBatches) {
              addedBatchIds.push(batch.batchId);
              for (const mutation of batch.mutations) {
                changedKeys = changedKeys.add(mutation.key);
              }
            }

            // Return the set of all (potentially) changed documents and the list
            // of mutation batch IDs that were affected by change.
            return this.localDocuments
              .getDocuments(txn, changedKeys)
              .next(affectedDocuments => {
                return {
                  affectedDocuments,
                  removedBatchIds,
                  addedBatchIds
                };
              });
          });
      }
    );
  }
  /* Accept locally generated Mutations and commit them to storage. */
  localWrite(mutations: Mutation[]): Promise<LocalWriteResult> {
    const localWriteTime = Timestamp.now();
    const keys = mutations.reduce(
      (keys, m) => keys.add(m.key),
      documentKeySet()
    );

    return this.persistence.runTransaction(
      'Locally write mutations',
      'readwrite',
      txn => {
        // Load and apply all existing mutations. This lets us compute the
        // current base state for all non-idempotent transforms before applying
        // any additional user-provided writes.
        return this.localDocuments
          .getDocuments(txn, keys)
          .next(existingDocs => {
            // For non-idempotent mutations (such as `FieldValue.increment()`),
            // we record the base state in a separate patch mutation. This is
            // later used to guarantee consistent values and prevents flicker
            // even if the backend sends us an update that already includes our
            // transform.
            const baseMutations: Mutation[] = [];

            for (const mutation of mutations) {
              const baseValue = mutation.extractBaseValue(
                existingDocs.get(mutation.key)
              );
              if (baseValue != null) {
                // NOTE: The base state should only be applied if there's some
                // existing document to override, so use a Precondition of
                // exists=true
                baseMutations.push(
                  new PatchMutation(
                    mutation.key,
                    baseValue,
                    baseValue.fieldMask(),
                    Precondition.exists(true)
                  )
                );
              }
            }

            return this.mutationQueue
              .addMutationBatch(txn, localWriteTime, baseMutations, mutations)
              .next(batch => {
                const changes = batch.applyToLocalDocumentSet(existingDocs);
                return { batchId: batch.batchId, changes };
              });
          });
      }
    );
  }

  /** Returns the local view of the documents affected by a mutation batch. */
  // PORTING NOTE: Multi-tab only.
  lookupMutationDocuments(batchId: BatchId): Promise<MaybeDocumentMap | null> {
    return this.persistence.runTransaction(
      'Lookup mutation documents',
      'readonly',
      txn => {
        return this.mutationQueue
          .lookupMutationKeys(txn, batchId)
          .next(keys => {
            if (keys) {
              return this.localDocuments.getDocuments(
                txn,
                keys
              ) as PersistencePromise<MaybeDocumentMap | null>;
            } else {
              return PersistencePromise.resolve<MaybeDocumentMap | null>(null);
            }
          });
      }
    );
  }

  /**
   * Acknowledge the given batch.
   *
   * On the happy path when a batch is acknowledged, the local store will
   *
   *  + remove the batch from the mutation queue;
   *  + apply the changes to the remote document cache;
   *  + recalculate the latency compensated view implied by those changes (there
   *    may be mutations in the queue that affect the documents but haven't been
   *    acknowledged yet); and
   *  + give the changed documents back the sync engine
   *
   * @returns The resulting (modified) documents.
   */
  acknowledgeBatch(
    batchResult: MutationBatchResult
  ): Promise<MaybeDocumentMap> {
    return this.persistence.runTransaction(
      'Acknowledge batch',
      'readwrite-primary',
      txn => {
        const affected = batchResult.batch.keys();
        const documentBuffer = this.remoteDocuments.newChangeBuffer({
          trackRemovals: true // Make sure document removals show up in `getNewDocumentChanges()`
        });
        return this.mutationQueue
          .acknowledgeBatch(txn, batchResult.batch, batchResult.streamToken)
          .next(() =>
            this.applyWriteToRemoteDocuments(txn, batchResult, documentBuffer)
          )
          .next(() => documentBuffer.apply(txn))
          .next(() => this.mutationQueue.performConsistencyCheck(txn))
          .next(() => this.localDocuments.getDocuments(txn, affected));
      }
    );
  }

  /**
   * Remove mutations from the MutationQueue for the specified batch;
   * LocalDocuments will be recalculated.
   *
   * @returns The resulting modified documents.
   */
  rejectBatch(batchId: BatchId): Promise<MaybeDocumentMap> {
    return this.persistence.runTransaction(
      'Reject batch',
      'readwrite-primary',
      txn => {
        let affectedKeys: DocumentKeySet;
        return this.mutationQueue
          .lookupMutationBatch(txn, batchId)
          .next((batch: MutationBatch | null) => {
            assert(batch !== null, 'Attempt to reject nonexistent batch!');
            affectedKeys = batch!.keys();
            return this.mutationQueue.removeMutationBatch(txn, batch!);
          })
          .next(() => {
            return this.mutationQueue.performConsistencyCheck(txn);
          })
          .next(() => {
            return this.localDocuments.getDocuments(txn, affectedKeys);
          });
      }
    );
  }

  /**
   * Returns the largest (latest) batch id in mutation queue that is pending server response.
   * Returns `BATCHID_UNKNOWN` if the queue is empty.
   */
  getHighestUnacknowledgedBatchId(): Promise<BatchId> {
    return this.persistence.runTransaction(
      'Get highest unacknowledged batch id',
      'readonly',
      txn => {
        return this.mutationQueue.getHighestUnacknowledgedBatchId(txn);
      }
    );
  }

  /** Returns the last recorded stream token for the current user. */
  getLastStreamToken(): Promise<ProtoByteString> {
    return this.persistence.runTransaction(
      'Get last stream token',
      'readonly',
      txn => {
        return this.mutationQueue.getLastStreamToken(txn);
      }
    );
  }

  /**
   * Sets the stream token for the current user without acknowledging any
   * mutation batch. This is usually only useful after a stream handshake or in
   * response to an error that requires clearing the stream token.
   */
  setLastStreamToken(streamToken: ProtoByteString): Promise<void> {
    return this.persistence.runTransaction(
      'Set last stream token',
      'readwrite-primary',
      txn => {
        return this.mutationQueue.setLastStreamToken(txn, streamToken);
      }
    );
  }

  /**
   * Returns the last consistent snapshot processed (used by the RemoteStore to
   * determine whether to buffer incoming snapshots from the backend).
   */
  getLastRemoteSnapshotVersion(): Promise<SnapshotVersion> {
    return this.persistence.runTransaction(
      'Get last remote snapshot version',
      'readonly',
      txn => this.queryCache.getLastRemoteSnapshotVersion(txn)
    );
  }

  /**
   * Update the "ground-state" (remote) documents. We assume that the remote
   * event reflects any write batches that have been acknowledged or rejected
   * (i.e. we do not re-apply local mutations to updates from this event).
   *
   * LocalDocuments are re-calculated if there are remaining mutations in the
   * queue.
   */
  applyRemoteEvent(remoteEvent: RemoteEvent): Promise<MaybeDocumentMap> {
    const documentBuffer = this.remoteDocuments.newChangeBuffer({
      trackRemovals: true // Make sure document removals show up in `getNewDocumentChanges()`
    });
    const remoteVersion = remoteEvent.snapshotVersion;
    return this.persistence.runTransaction(
      'Apply remote event',
      'readwrite-primary',
      txn => {
        const promises = [] as Array<PersistencePromise<void>>;
        objUtils.forEachNumber(
          remoteEvent.targetChanges,
          (targetId: TargetId, change: TargetChange) => {
            const oldQueryData = this.queryDataByTarget[targetId];
            if (!oldQueryData) {
              return;
            }

            // Only update the remote keys if the query is still active. This
            // ensures that we can persist the updated query data along with
            // the updated assignment.
            promises.push(
              this.queryCache
                .removeMatchingKeys(txn, change.removedDocuments, targetId)
                .next(() => {
                  return this.queryCache.addMatchingKeys(
                    txn,
                    change.addedDocuments,
                    targetId
                  );
                })
            );

            const resumeToken = change.resumeToken;
            // Update the resume token if the change includes one.
            if (resumeToken.length > 0) {
              const newQueryData = oldQueryData
                .withResumeToken(resumeToken, remoteVersion)
                .withSequenceNumber(txn.currentSequenceNumber);
              this.queryDataByTarget[targetId] = newQueryData;

              // Update the query data if there are target changes (or if
              // sufficient time has passed since the last update).
              if (
                LocalStore.shouldPersistQueryData(
                  oldQueryData,
                  newQueryData,
                  change
                )
              ) {
                promises.push(
                  this.queryCache.updateQueryData(txn, newQueryData)
                );
              }
            }
          }
        );

        let changedDocs = maybeDocumentMap();
        let updatedKeys = documentKeySet();
        remoteEvent.documentUpdates.forEach((key, doc) => {
          updatedKeys = updatedKeys.add(key);
        });

        // Each loop iteration only affects its "own" doc, so it's safe to get all the remote
        // documents in advance in a single call.
        promises.push(
          documentBuffer.getEntries(txn, updatedKeys).next(existingDocs => {
            remoteEvent.documentUpdates.forEach((key, doc) => {
              const existingDoc = existingDocs.get(key);

              // Note: The order of the steps below is important, since we want
              // to ensure that rejected limbo resolutions (which fabricate
              // NoDocuments with SnapshotVersion.MIN) never add documents to
              // cache.
              if (
                doc instanceof NoDocument &&
                doc.version.isEqual(SnapshotVersion.MIN)
              ) {
                // NoDocuments with SnapshotVersion.MIN are used in manufactured
                // events. We remove these documents from cache since we lost
                // access.
                documentBuffer.removeEntry(key, remoteVersion);
                changedDocs = changedDocs.insert(key, doc);
              } else if (
                existingDoc == null ||
                doc.version.compareTo(existingDoc.version) > 0 ||
                (doc.version.compareTo(existingDoc.version) === 0 &&
                  existingDoc.hasPendingWrites)
              ) {
                // TODO(index-free): Make this an assert when we enable
                // Index-Free queries
                if (SnapshotVersion.MIN.isEqual(remoteVersion)) {
                  log.error(
                    LOG_TAG,
                    'Cannot add a document when the remote version is zero'
                  );
                }
                documentBuffer.addEntry(doc, remoteVersion);
                changedDocs = changedDocs.insert(key, doc);
              } else {
                log.debug(
                  LOG_TAG,
                  'Ignoring outdated watch update for ',
                  key,
                  '. Current version:',
                  existingDoc.version,
                  ' Watch version:',
                  doc.version
                );
              }

              if (remoteEvent.resolvedLimboDocuments.has(key)) {
                promises.push(
                  this.persistence.referenceDelegate.updateLimboDocument(
                    txn,
                    key
                  )
                );
              }
            });
          })
        );

        // HACK: The only reason we allow a null snapshot version is so that we
        // can synthesize remote events when we get permission denied errors while
        // trying to resolve the state of a locally cached document that is in
        // limbo.
        if (!remoteVersion.isEqual(SnapshotVersion.MIN)) {
          const updateRemoteVersion = this.queryCache
            .getLastRemoteSnapshotVersion(txn)
            .next(lastRemoteSnapshotVersion => {
              assert(
                remoteVersion.compareTo(lastRemoteSnapshotVersion) >= 0,
                'Watch stream reverted to previous snapshot?? ' +
                  remoteVersion +
                  ' < ' +
                  lastRemoteSnapshotVersion
              );
              return this.queryCache.setTargetsMetadata(
                txn,
                txn.currentSequenceNumber,
                remoteVersion
              );
            });
          promises.push(updateRemoteVersion);
        }

        return PersistencePromise.waitFor(promises)
          .next(() => documentBuffer.apply(txn))
          .next(() => {
            return this.localDocuments.getLocalViewOfDocuments(
              txn,
              changedDocs
            );
          });
      }
    );
  }

  /**
   * Returns true if the newQueryData should be persisted during an update of
   * an active target. QueryData should always be persisted when a target is
   * being released and should not call this function.
   *
   * While the target is active, QueryData updates can be omitted when nothing
   * about the target has changed except metadata like the resume token or
   * snapshot version. Occasionally it's worth the extra write to prevent these
   * values from getting too stale after a crash, but this doesn't have to be
   * too frequent.
   */
  private static shouldPersistQueryData(
    oldQueryData: QueryData,
    newQueryData: QueryData,
    change: TargetChange
  ): boolean {
    assert(
      newQueryData.resumeToken.length > 0,
      'Attempted to persist query data with no resume token'
    );

    // Always persist query data if we don't already have a resume token.
    if (oldQueryData.resumeToken.length === 0) {
      return true;
    }

    // Don't allow resume token changes to be buffered indefinitely. This
    // allows us to be reasonably up-to-date after a crash and avoids needing
    // to loop over all active queries on shutdown. Especially in the browser
    // we may not get time to do anything interesting while the current tab is
    // closing.
    const timeDelta =
      newQueryData.snapshotVersion.toMicroseconds() -
      oldQueryData.snapshotVersion.toMicroseconds();
    if (timeDelta >= this.RESUME_TOKEN_MAX_AGE_MICROS) {
      return true;
    }

    // Otherwise if the only thing that has changed about a target is its resume
    // token it's not worth persisting. Note that the RemoteStore keeps an
    // in-memory view of the currently active targets which includes the current
    // resume token, so stream failure or user changes will still use an
    // up-to-date resume token regardless of what we do here.
    const changes =
      change.addedDocuments.size +
      change.modifiedDocuments.size +
      change.removedDocuments.size;
    return changes > 0;
  }

  /**
   * Notify local store of the changed views to locally pin documents.
   */
  notifyLocalViewChanges(viewChanges: LocalViewChanges[]): Promise<void> {
    return this.persistence.runTransaction(
      'notifyLocalViewChanges',
      'readwrite',
      txn => {
        return PersistencePromise.forEach(
          viewChanges,
          (viewChange: LocalViewChanges) => {
            const targetId = viewChange.targetId;

            this.localViewReferences.addReferences(
              viewChange.addedKeys,
              targetId
            );
            this.localViewReferences.removeReferences(
              viewChange.removedKeys,
              targetId
            );

            if (!viewChange.fromCache) {
              const queryData = this.queryDataByTarget[targetId];
              assert(
                queryData !== undefined,
                `Can't set limbo-free snapshot version for unknown target: ${targetId}`
              );

              // Advance the last limbo free snapshot version
              const lastLimboFreeSnapshotVersion = queryData.snapshotVersion;
              const updatedQueryData = queryData.withLastLimboFreeSnapshotVersion(
                lastLimboFreeSnapshotVersion
              );
              this.queryDataByTarget[targetId] = updatedQueryData;
            }
            return PersistencePromise.forEach(
              viewChange.removedKeys,
              (key: DocumentKey) =>
                this.persistence.referenceDelegate.removeReference(txn, key)
            );
          }
        );
      }
    );
  }

  /**
   * Gets the mutation batch after the passed in batchId in the mutation queue
   * or null if empty.
   * @param afterBatchId If provided, the batch to search after.
   * @returns The next mutation or null if there wasn't one.
   */
  nextMutationBatch(afterBatchId?: BatchId): Promise<MutationBatch | null> {
    return this.persistence.runTransaction(
      'Get next mutation batch',
      'readonly',
      txn => {
        if (afterBatchId === undefined) {
          afterBatchId = BATCHID_UNKNOWN;
        }
        return this.mutationQueue.getNextMutationBatchAfterBatchId(
          txn,
          afterBatchId
        );
      }
    );
  }

  /**
   * Read the current value of a Document with a given key or null if not
   * found - used for testing.
   */
  readDocument(key: DocumentKey): Promise<MaybeDocument | null> {
    return this.persistence.runTransaction('read document', 'readonly', txn => {
      return this.localDocuments.getDocument(txn, key);
    });
  }

  /**
   * Assigns the given query an internal ID so that its results can be pinned so
   * they don't get GC'd. A query must be allocated in the local store before
   * the store can be used to manage its view.
   */
  allocateQuery(query: Query): Promise<QueryData> {
    return this.persistence.runTransaction(
      'Allocate query',
      'readwrite',
      txn => {
        let queryData: QueryData;
        return this.queryCache
          .getQueryData(txn, query)
          .next((cached: QueryData | null) => {
            if (cached) {
              // This query has been listened to previously, so reuse the
              // previous targetID.
              // TODO(mcg): freshen last accessed date?
              queryData = cached;
              return PersistencePromise.resolve();
            } else {
              return this.queryCache.allocateTargetId(txn).next(targetId => {
                queryData = new QueryData(
                  query,
                  targetId,
                  QueryPurpose.Listen,
                  txn.currentSequenceNumber
                );
                return this.queryCache.addQueryData(txn, queryData);
              });
            }
          })
          .next(() => {
            assert(
              !this.queryDataByTarget[queryData.targetId],
              'Tried to allocate an already allocated query: ' + query
            );
            this.queryDataByTarget[queryData.targetId] = queryData;
            this.targetIdByQuery.set(query, queryData.targetId);
            return queryData;
          });
      }
    );
  }

  /**
   * Returns the QueryData as seen by the LocalStore, including updates that may
   * have not yet been persisted to the QueryCache.
   */
  // Visible for testing.
  getQueryData(
    transaction: PersistenceTransaction,
    query: Query
  ): PersistencePromise<QueryData | null> {
    const targetId = this.targetIdByQuery.get(query);
    if (targetId !== undefined) {
      return PersistencePromise.resolve<QueryData | null>(
        this.queryDataByTarget[targetId]
      );
    } else {
      return this.queryCache.getQueryData(transaction, query);
    }
  }

  /**
   * Unpin all the documents associated with the given query. If
   * `keepPersistedQueryData` is set to false and Eager GC enabled, the method
   * directly removes the associated query data from the query cache.
   */
  // PORTING NOTE: `keepPersistedQueryData` is multi-tab only.
  releaseQuery(query: Query, keepPersistedQueryData: boolean): Promise<void> {
    const mode = keepPersistedQueryData ? 'readwrite' : 'readwrite-primary';
    return this.persistence.runTransaction('Release query', mode, txn => {
      const targetId = this.targetIdByQuery.get(query);
      assert(
        targetId !== undefined,
        'Tried to release nonexistent query: ' + query
      );
      const queryData = this.queryDataByTarget[targetId!]!;

      // References for documents sent via Watch are automatically removed
      // when we delete a query's target data from the reference delegate.
      // Since this does not remove references for locally mutated documents,
      // we have to remove the target associations for these documents
      // manually.
      const removed = this.localViewReferences.removeReferencesForId(targetId!);
      delete this.queryDataByTarget[targetId!];
      this.targetIdByQuery.delete(query);

      if (!keepPersistedQueryData) {
        return PersistencePromise.forEach(removed, (key: DocumentKey) =>
          this.persistence.referenceDelegate.removeReference(txn, key)
        ).next(() => {
          this.persistence.referenceDelegate.removeTarget(txn, queryData);
        });
      } else {
        return PersistencePromise.resolve();
      }
    });
  }

  /**
   * Runs the specified query against the local store and returns the results,
   * potentially taking advantage of query data from previous executions (such
   * as the set of remote keys).
   *
   * @param usePreviousResults Whether results from previous executions can
   * be used to optimize this query execution.
   */
  executeQuery(
    query: Query,
    usePreviousResults: boolean
  ): Promise<QueryResult> {
    let lastLimboFreeSnapshotVersion = SnapshotVersion.MIN;
    let remoteKeys = documentKeySet();

    return this.persistence.runTransaction('Execute query', 'readonly', txn => {
      return this.getQueryData(txn, query)
        .next(queryData => {
          if (queryData) {
            lastLimboFreeSnapshotVersion =
              queryData.lastLimboFreeSnapshotVersion;
            return this.queryCache
              .getMatchingKeysForTargetId(txn, queryData.targetId)
              .next(result => {
                remoteKeys = result;
              });
          }
        })
        .next(() =>
          this.queryEngine.getDocumentsMatchingQuery(
            txn,
            query,
            usePreviousResults
              ? lastLimboFreeSnapshotVersion
              : SnapshotVersion.MIN,
            usePreviousResults ? remoteKeys : documentKeySet()
          )
        )
        .next(documents => {
          return { documents, remoteKeys };
        });
    });
  }

  /**
   * Returns the keys of the documents that are associated with the given
   * target id in the remote table.
   */
  remoteDocumentKeys(targetId: TargetId): Promise<DocumentKeySet> {
    return this.persistence.runTransaction(
      'Remote document keys',
      'readonly',
      txn => {
        return this.queryCache.getMatchingKeysForTargetId(txn, targetId);
      }
    );
  }

  // PORTING NOTE: Multi-tab only.
  getActiveClients(): Promise<ClientId[]> {
    return this.persistence.getActiveClients();
  }

  // PORTING NOTE: Multi-tab only.
  removeCachedMutationBatchMetadata(batchId: BatchId): void {
    this.mutationQueue.removeCachedMutationKeys(batchId);
  }

  // PORTING NOTE: Multi-tab only.
  setNetworkEnabled(networkEnabled: boolean): void {
    this.persistence.setNetworkEnabled(networkEnabled);
  }

  private applyWriteToRemoteDocuments(
    txn: PersistenceTransaction,
    batchResult: MutationBatchResult,
    documentBuffer: RemoteDocumentChangeBuffer
  ): PersistencePromise<void> {
    const batch = batchResult.batch;
    const docKeys = batch.keys();
    let promiseChain = PersistencePromise.resolve();
    docKeys.forEach(docKey => {
      promiseChain = promiseChain
        .next(() => {
          return documentBuffer.getEntry(txn, docKey);
        })
        .next((remoteDoc: MaybeDocument | null) => {
          let doc = remoteDoc;
          const ackVersion = batchResult.docVersions.get(docKey);
          assert(
            ackVersion !== null,
            'ackVersions should contain every doc in the write.'
          );
          if (!doc || doc.version.compareTo(ackVersion!) < 0) {
            doc = batch.applyToRemoteDocument(docKey, doc, batchResult);
            if (!doc) {
              assert(
                !remoteDoc,
                'Mutation batch ' +
                  batch +
                  ' applied to document ' +
                  remoteDoc +
                  ' resulted in null'
              );
            } else {
              // We use the commitVersion as the readTime rather than the
              // document's updateTime since the updateTime is not advanced
              // for updates that do not modify the underlying document.
              documentBuffer.addEntry(doc, batchResult.commitVersion);
            }
          }
        });
    });
    return promiseChain.next(() =>
      this.mutationQueue.removeMutationBatch(txn, batch)
    );
  }

  collectGarbage(garbageCollector: LruGarbageCollector): Promise<LruResults> {
    return this.persistence.runTransaction(
      'Collect garbage',
      'readwrite-primary',
      txn => garbageCollector.collect(txn, this.queryDataByTarget)
    );
  }

  // PORTING NOTE: Multi-tab only.
  getQueryForTarget(targetId: TargetId): Promise<Query | null> {
    if (this.queryDataByTarget[targetId]) {
      return Promise.resolve(this.queryDataByTarget[targetId].query);
    } else {
      return this.persistence.runTransaction(
        'Get query data',
        'readonly',
        txn => {
          return this.queryCache
            .getQueryDataForTarget(txn, targetId)
            .next(queryData => (queryData ? queryData.query : null));
        }
      );
    }
  }

  // PORTING NOTE: Multi-tab only.
  getNewDocumentChanges(): Promise<MaybeDocumentMap> {
    return this.persistence.runTransaction(
      'Get new document changes',
      'readonly',
      txn => {
        return this.remoteDocuments.getNewDocumentChanges(txn);
      }
    );
  }
}
