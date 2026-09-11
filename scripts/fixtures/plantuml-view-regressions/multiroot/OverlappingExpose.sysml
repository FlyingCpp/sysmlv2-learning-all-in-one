package OverlappingExpose {
part a { part child { port p; } }
view target : StandardViewDefinitions::InterconnectionView { expose a::**; expose a::child; }
}
