package 'DJI风格四旋翼无人机架构模型' {
	doc /* 教学用基线模型：参考大疆（DJI）风格消费级四旋翼无人机的公开通用架构特征。
	     本模型采用显式、可逆的最小假设表达通用架构，不针对任何具体型号，
	     不虚构无法核验的具体型号名、精确芯片型号或性能指标。 */

	// ==================== 1. 需求 ====================
	package Requirements {
		private import 'Structure'::*;

		requirement def EnduranceBatteryRequirement {
			doc /* 续航与电池：无人机应依靠机载可充电电池供电，续航时间满足典型消费级航拍任务需要。 */
			subject battery : Battery;
		}

		requirement def HoverStabilityRequirement {
			doc /* 悬停稳定性：无人机应能在GNSS可用条件下保持位置和姿态稳定悬停。 */
			subject drone : Drone;
		}

		requirement def RemoteLinkRequirement {
			doc /* 遥控通信链路：无人机应能与外部遥控器建立双向遥控/图传链路。 */
			subject radioLinkReceiver : RadioLinkReceiver;
		}

		requirement def RTHSafetyRequirement {
			doc /* 返航安全：无人机应在低电量或链路失联等触发条件下自动返航并安全降落。 */
			subject drone : Drone;
		}

		requirement def TakeoffLandingControlRequirement {
			doc /* 起飞/降落控制：无人机应支持从上电自检到断电的完整受控起降流程。 */
			subject flightController : FlightController;
		}

		// 需求用法（供 satisfy 追溯引用）
		requirement enduranceReq : EnduranceBatteryRequirement;
		requirement hoverStabilityReq : HoverStabilityRequirement;
		requirement remoteLinkReq : RemoteLinkRequirement;
		requirement rthSafetyReq : RTHSafetyRequirement;
		requirement takeoffLandingReq : TakeoffLandingControlRequirement;

		// 整机需求组（需求包含关系）
		requirement droneSpecification {
			doc /* 无人机整机需求组：悬停稳定与返航安全为整机级需求。 */
			subject drone : Drone;

			require hoverStabilityReq;
			require rthSafetyReq;
		}
	}

	// ==================== 2. 无人机整体组成 ====================
	package 'Structure' {
		// —— 端口类型定义 ——
		port def PowerPort;
		port def DataPort;
		port def ControlPort;

		// —— 部件定义 ——
		part def Battery {
			port powerOut : PowerPort;
		}

		part def Motor;
		part def ESC {
			port cmdIn : ControlPort;
		}

		part def PropulsionUnit {
			doc /* 推进子系统（教学简化）：四个旋翼对应四组电机与电调。 */
			port cmdIn : ControlPort;
			part motor[4] : Motor;
			part esc[4] : ESC;
		}

		part def GimbalCamera;
		part def GNSSReceiver {
			port dataOut : DataPort;
		}
		part def RadioLinkReceiver {
			port dataIn : DataPort;
		}
		part def Airframe;
		part def LandingGear;
		part def RemoteController {
			port linkOut : DataPort;
		}

		// —— 飞控（内部组成与接口关系见第3部分） ——
		part def MainProcessor {
			port imuIn : DataPort;
			port baroIn : DataPort;
			port magIn : DataPort;
			port gnssIn : DataPort;
			port rcIn : DataPort;
			port motorCmd : ControlPort;
		}
		part def IMU {
			port dataOut : DataPort;
		}
		part def Barometer {
			port dataOut : DataPort;
		}
		part def Magnetometer {
			port dataOut : DataPort;
		}
		part def GnssInterface {
			port dataIn : DataPort;
			port dataOut : DataPort;
		}
		part def RemoteInputProcessor {
			port dataIn : DataPort;
			port dataOut : DataPort;
		}
		part def MotorOutputController {
			port cmdIn : ControlPort;
			port escOut : ControlPort;
		}

		part def FlightController {
			doc /* 飞控内部组成：主处理器、IMU、气压计、罗盘/磁力计、GNSS接入接口、
			     遥控输入处理、电机输出控制。 */
			port powerIn : PowerPort;

			part mainProcessor : MainProcessor;
			part imu : IMU;
			part barometer : Barometer;
			part magnetometer : Magnetometer;
			part gnssInterface : GnssInterface;
			part remoteInputProcessor : RemoteInputProcessor;
			part motorOutputController : MotorOutputController;

			// 飞控内部连接：传感器 → 主处理器 → 电机输出
			connect imu.dataOut to mainProcessor.imuIn;
			connect barometer.dataOut to mainProcessor.baroIn;
			connect magnetometer.dataOut to mainProcessor.magIn;
			connect gnssInterface.dataOut to mainProcessor.gnssIn;
			connect remoteInputProcessor.dataOut to mainProcessor.rcIn;
			connect mainProcessor.motorCmd to motorOutputController.cmdIn;
		}

		// —— 无人机整机 ——
		part def Drone {
			doc /* 无人机整机组成：飞控、电池、推进子系统、云台相机、GNSS接收机、
			     遥控/图传链路接收部分、机身与起落架。遥控器不在其内部（系统边界见系统上下文）。 */
			part flightController : FlightController;
			part battery : Battery;
			part propulsion : PropulsionUnit;
			part gimbalCamera : GimbalCamera;
			part gnssReceiver : GNSSReceiver;
			part radioLinkReceiver : RadioLinkReceiver;
			part airframe : Airframe;
			part landingGear : LandingGear;

			// 整机级连接
			connect battery.powerOut to flightController.powerIn;
			connect gnssReceiver.dataOut to flightController.gnssInterface.dataIn;
			connect radioLinkReceiver.dataIn to flightController.remoteInputProcessor.dataIn;
			connect flightController.motorOutputController.escOut to propulsion.cmdIn;
		}

		// —— 系统上下文（体现系统边界） ——
		part def DroneSystemContext {
			doc /* 系统上下文：遥控器是无人机外部的协同部件，不属于无人机内部组成。 */
			part drone : Drone;
			part remoteController : RemoteController;

			// 外部遥控链路
			connect remoteController.linkOut to drone.radioLinkReceiver.dataIn;

			// —— 声明性追溯（satisfy 简写，不声称验证） ——
			satisfy Requirements::enduranceReq by drone.battery;
			satisfy Requirements::remoteLinkReq by drone.radioLinkReceiver;
			satisfy Requirements::takeoffLandingReq by drone.flightController;
			satisfy Requirements::droneSpecification by drone;
		}
	}

	// ==================== 4. 起飞到落地的控制时序 ====================
	package Behavior {
		action def FlightControlSequence {
			doc /* 起飞到落地的控制时序（教学简化版）。
			     低电量触发返航：巡航/任务飞行阶段持续监测电量，
			     当电量低于返航阈值时提前进入返航阶段；
			     该决策分支在本教学模型中以注释表达，不展开完整分支结构。 */
			action powerOnSelfTest;
			then action armAndPrepare;
			then action takeoffAndClimb;
			then action cruiseMission;
			then action returnToHome;
			then action approachAndDescend;
			then action land;
			then action powerOff;
		}
	}

	// ==================== 视图 ====================
	package Views {
		// 通用视图：无人机组成与系统边界
		view droneCompositionView : StandardViewDefinitions::GeneralView {
			expose 'Structure'::DroneSystemContext;
			expose 'Structure'::Drone;
		}

		// 互连视图：飞控内部接口关系（连接定义在 FlightController 内，故 expose 该定义）
		view flightControllerInterfaceView : StandardViewDefinitions::InterconnectionView {
			expose 'Structure'::FlightController;
		}

		// 动作流视图：起飞到落地的控制时序
		view flightControlFlowView : StandardViewDefinitions::ActionFlowView {
			expose Behavior::FlightControlSequence;
		}

		// 浏览视图：整体层次结构
		view modelBrowserView : StandardViewDefinitions::BrowserView {
			expose 'DJI风格四旋翼无人机架构模型'::**;
		}
	}
}