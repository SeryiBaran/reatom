import * as v3 from '@reatom/core'
import { Tree, State, TreeId, createCtx, BaseAction } from './kernel'
import {
  throwError,
  getTree,
  safetyFunc,
  assign,
  getIsAtom,
  getIsAction,
  getOwnKeys,
  TREE,
} from './shared'
import { Action, PayloadActionCreator } from './declareAction'
import { Atom, initAction, getState } from './declareAtom'

type ActionsSubscriber = (action: Action<unknown>, stateDiff: State) => any
type SubscribeFunction = {
  <T>(
    target: Atom<T> | PayloadActionCreator<T>,
    listener: (state: T) => any,
  ): () => void
  (listener: ActionsSubscriber): () => void
}
type GetStateFunction = {
  <T>(target: Atom<T>): T
  (): State
}

export type Store = {
  dispatch: <T>(action: Action<T>) => void
  subscribe: SubscribeFunction
  getState: GetStateFunction
  bind: <A extends (...a: any[]) => BaseAction>(
    a: A,
  ) => (...a: A extends (...a: infer Args) => any ? Args : never) => void
  v3ctx: v3.Ctx
}

export function createStore(initState?: State): Store
export function createStore(atom: Atom<any>, initState?: State): Store
// TODO: try to use ES6 Map's instead of plain object
// for prevent using `delete` operator
// (need perf tests)
export function createStore(
  atom?: Atom<any> | State,
  initState?: State,
  v3ctx = v3.createContext(),
): Store {
  let listeners: Map<TreeId, Function[]> = new Map<TreeId, Function[]>()
  let nextListeners: Map<TreeId, Function[]> = listeners
  let dispatchListeners: Function[] = []
  let nextDispatchListeners: Function[] = dispatchListeners
  let initialAtoms = new Set<TreeId>()
  let state: State = {}
  const storeTree = new Tree('store')
  if (atom !== undefined) {
    if (typeof atom === 'object' && initState === undefined) assign(state, atom)
    else {
      if (!getIsAtom(atom)) throwError('Invalid atom')
      if (typeof initState === 'object' && initState !== null)
        assign(state, initState)
      else if (initState !== undefined) throwError('Invalid initial state')

      storeTree.union(getTree(atom as Atom<any>))
      const ctx = createCtx(state, initAction)
      storeTree.forEach(initAction.type, ctx)
      assign(state, ctx.stateNew)
      initialAtoms = new Set(getOwnKeys(ctx.stateNew))
    }
  }

  function ensureCanMutateNextDispatchListeners() {
    if (nextDispatchListeners === dispatchListeners) {
      nextDispatchListeners = dispatchListeners.slice()
    }
  }

  function ensureCanMutateNextListeners(treeId: TreeId) {
    if (nextListeners === listeners) {
      nextListeners = new Map()
      listeners.forEach((value, key) =>
        nextListeners.set(key, treeId === key ? value.slice() : value),
      )
    }
  }

  function _getState(): State
  function _getState<T>(target?: Atom<T>): State | T {
    // TODO: try to cache `assign`
    if (target === undefined) return assign({}, state) as State

    if (!getIsAtom(target)) throwError('Invalid target')

    const targetState = getState<T>(state, target)
    if (targetState !== undefined) return targetState

    const ctx = createCtx(state, initAction)
    getTree(target).forEach(initAction.type, ctx)

    // @ts-ignore
    return getState(ctx.stateNew, target)
  }

  function subscribe(subscriber: ActionsSubscriber): () => void
  function subscribe<T>(
    target: Atom<T> | PayloadActionCreator<T>,
    subscriber: (state: T) => any,
  ): () => void
  function subscribe<T>(
    target: Atom<T> | PayloadActionCreator<T> | ActionsSubscriber,
    subscriber?: (state: T) => any,
  ): () => void {
    const listener = safetyFunc(subscriber || target, 'listener')
    let isSubscribed = true

    if (subscriber === undefined) {
      if (getIsAtom(listener) || getIsAction(listener))
        throwError('Invalid listener')

      ensureCanMutateNextDispatchListeners()
      nextDispatchListeners.push(listener)
      return () => {
        if (!isSubscribed) return
        isSubscribed = false
        ensureCanMutateNextDispatchListeners()
        nextDispatchListeners.splice(nextDispatchListeners.indexOf(listener), 1)
      }
    }

    const isAction = getIsAction(target)
    if (!getIsAtom(target) && !isAction)
      throwError('Invalid subscription target')
    const targetTree = getTree(target as Atom<T> | PayloadActionCreator<T>)
    const targetId = targetTree.id
    const isLazy = !isAction && !initialAtoms.has(targetId)

    ensureCanMutateNextListeners(targetId)
    if (!nextListeners.has(targetId)) {
      nextListeners.set(targetId, [])
      if (isLazy) {
        storeTree.union(targetTree)
        const ctx = createCtx(state, initAction)
        targetTree.forEach(initAction.type, ctx)
        assign(state, ctx.stateNew)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    nextListeners.get(targetId)!.push(listener)

    return () => {
      if (!isSubscribed) return
      isSubscribed = false

      ensureCanMutateNextListeners(targetId)
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const _listeners = nextListeners.get(targetId)!
      _listeners.splice(_listeners.indexOf(listener), 1)

      if (isLazy && _listeners.length === 0) {
        nextListeners.delete(targetId)
        storeTree.disunion(targetTree, (id) => {
          delete state[id as string]
        })
      }
    }
  }

  function dispatch(action: Action<any>) {
    const { type, payload, reactions } = action
    if (
      typeof action !== 'object' ||
      action === null ||
      typeof type !== 'string'
    )
      throwError('Invalid action')

    const ctx = createCtx(state, action)
    const { changedIds, changedAtoms, stateNew } = ctx

    v3ctx.run(() => {
      storeTree.forEach(type, ctx)

      listeners = nextListeners

      if (type === initAction.type) state = payload || {}

      assign(state, stateNew)

      changedAtoms.forEach((atom) => {
        v3ctx['🙊'](atom.v3atom.__reatom, (ctx, patch) => {
          patch.state = stateNew[atom[TREE].id]
        })
      })
    })

    if (changedIds.length > 0) {
      for (let i = 0; i < changedIds.length; i++) {
        const id = changedIds[i]!
        callFromList(listeners.get(id) || [], stateNew[id as string])
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    callFromList(reactions || [], payload, store)
    callFromList(listeners.get(type) || [], payload)
    callFromList((dispatchListeners = nextDispatchListeners), action, stateNew)
  }

  const bind: Store['bind'] =
    (actionCreator) =>
    (...a) =>
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      store.dispatch(actionCreator(...a))

  const store = {
    getState: _getState,
    subscribe,
    dispatch,
    bind,
    v3ctx,
  }

  return store
}

function callFromList(list: Function[], ...arg: any[]) {
  let i = -1
  while (++i < list.length) list[i]!(...arg)
}