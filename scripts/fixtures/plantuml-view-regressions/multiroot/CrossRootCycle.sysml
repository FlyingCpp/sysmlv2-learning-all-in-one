package CrossRootCycle {
part a { port p; } part b { port p; } part c { port p; } connection ab connect a.p to b.p; connection bc connect b.p to c.p; connection ca connect c.p to a.p;
view target : StandardViewDefinitions::InterconnectionView { expose a; expose b; expose c; expose ab; expose bc; expose ca; }
}
