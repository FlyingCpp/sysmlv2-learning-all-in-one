package EV_C08_L01 {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;

  calc def EstimateRange {
    in usableEnergyKWh : ScalarValues::Real;
    in energyPer100Km : ScalarValues::Real;
    // TODO 1: 添加 rawRangeKm return，用能量和百公里能耗计算
  }

  calc candidateRangeEstimate : EstimateRange {
    in usableEnergyKWh = evPrototype.battery.usableEnergyKWh;
    in energyPer100Km = evPrototype.energyPer100Km;
    // TODO 2: 添加 calc usage 的 rawRangeKm return
  }

  view def RangeCalculationView specializes StandardViewDefinitions::GeneralView;
  view rangeCalculationView : RangeCalculationView {
    expose vehicleRange;
    expose evPrototype;
    expose EstimateRange;
    expose candidateRangeEstimate;
  }
}
