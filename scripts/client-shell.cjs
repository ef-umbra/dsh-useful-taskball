window.__ModuleLoader__.load({
  id: 'dsh-useful-taskball',
  factory(require) {
    const registry = {}
    const cache = {}
    function define(name, deps, declare) {
      registry[name] = { deps, declare }
    }
    function resolve(name, module) {
      if (name === 'exports') return module.exports
      if (name === 'module') return module
      if (name === 'require') return (id) => require(id)
      if (name === 'react') return require('react')
      return instantiate(name)
    }
    function instantiate(name) {
      if (cache[name] !== undefined) return cache[name]
      const entry = registry[name]
      if (entry === undefined) throw new Error(`Unknown client module: ${name}`)
      const module = { exports: {} }
      cache[name] = module.exports
      entry.declare.apply(null, entry.deps.map((dep) => resolve(dep, module)))
      cache[name] = module.exports
      return module.exports
    }
    /*__TASKBALL_CLIENT_BUNDLE__*/
    return instantiate('index')
  },
})
