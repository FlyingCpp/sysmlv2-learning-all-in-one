package CrossRootConnection {
part a { port p; } part b { port p; } connection ab connect a.p to b.p;
view target : StandardViewDefinitions::InterconnectionView { expose a; expose b; expose ab; }
}
