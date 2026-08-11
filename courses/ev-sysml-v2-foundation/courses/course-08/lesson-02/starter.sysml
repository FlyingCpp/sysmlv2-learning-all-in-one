package EV_C08_L02 {
  private import EV_Program_Baseline::*;
  private import EV_Requirement_Baseline::*;
  private import EV_Range_Calc_Baseline::*;

  analysis def RangeEvidenceAnalysis {
    subject vehicle : ElectricVehicle;
    in targetRangeKm : ScalarValues::Real;
    in reportedPredictionKm : ScalarValues::Real;

    // TODO 1: 添加 rangeDecisionObjective objective，检查预测值与需求目标

    calc estimateRange : EstimateRange {
      // TODO 2: 添加 usableEnergyKWh 和 energyPer100Km 的 in 参数绑定
      // TODO 3: 添加 calc usage 的 rawRangeKm return
    }

    // TODO 4: 添加 predictedRangeKm analysis return，取 reportedPredictionKm
  }

  analysis cityRangeAnalysis : RangeEvidenceAnalysis {
    subject vehicle = evPrototype;
    in targetRangeKm = vehicleRange.minRangeKm;
    // TODO 5: 添加 reportedPredictionKm 的 in 参数绑定，来源为 490.0 km 报告值
  }

  view def RangeAnalysisView specializes StandardViewDefinitions::GeneralView;
  view rangeAnalysisView : RangeAnalysisView {
    expose vehicleRange;
    expose EstimateRange;
    expose cityRangeAnalysis;
    expose evPrototype;
  }
}
