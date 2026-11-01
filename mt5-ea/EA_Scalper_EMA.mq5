//+------------------------------------------------------------------+
//|                                               EA_Scalper_EMA.mq5 |
//|  Scalping EMA 7 / 14 / 28 (banyak trade sehari)                  |
//|                                                                  |
//|   Trend   : EMA 7 > 14 > 28 = BUY sahaja | 7 < 14 < 28 = SELL    |
//|   Penapis : EMA H1 (kuning atas = buy sahaja, bawah = sell)      |
//|   Entry   : candle M5 tutup selepas pullback sentuh EMA, dan     |
//|             tutup semula ikut arah trend (rejection)             |
//|   Keluar  : TP 5 pip, SL 10 pip (+ pilihan break-even / masa)    |
//|   Risiko  : 1 posisi pada satu masa, waktu 3PM-12AM MYT,         |
//|             tapis spread & news, berhenti selepas 3 loss sehari  |
//+------------------------------------------------------------------+
#property copyright "EMA Scalper"
#property version   "1.00"
#property description "Scalping EMA 7/14/28 M5 + penapis H1. TP 5 pip, SL 10 pip, had loss harian."

#include <Trade\Trade.mqh>

//--- enums
enum ENUM_GMT_MODE
  {
   GMT_AUTO   = 0, // Auto (live: kira sendiri | tester: GMT+2/+3 ikut DST US)
   GMT_MANUAL = 1  // Manual (guna nilai ServerGMTOffset)
  };

enum ENUM_EMA_MODE
  {
   EMA_FULL_STACK     = 0, // Susunan penuh (7>14>28 buy | 7<14<28 sell)
   EMA_YELLOW_VS_BOTH = 1, // EMA7 atas/bawah EMA14 DAN EMA28
   EMA_YELLOW_VS_MID  = 2  // EMA7 atas/bawah EMA14 sahaja
  };

enum ENUM_PULLBACK
  {
   PB_FAST = 0, // Sentuh EMA 7 (kuning)
   PB_MID  = 1  // Sentuh EMA 14 (biru) - lebih dalam, kurang signal
  };

//--- inputs
input group "=== Signal (Scalping) ==="
input ENUM_TIMEFRAMES SignalTF        = PERIOD_M5;      // Timeframe signal
input int             EMA_Fast        = 7;              // EMA laju (kuning)
input int             EMA_Mid         = 14;             // EMA sederhana (biru)
input int             EMA_Slow        = 28;             // EMA perlahan (ungu)
input ENUM_EMA_MODE   TrendMode       = EMA_FULL_STACK; // Syarat trend EMA
input ENUM_PULLBACK   PullbackTo      = PB_FAST;        // Pullback mesti sentuh
input bool            RequireCandleDir = true;          // Candle signal mesti ikut arah (hijau buy / merah sell)
input double          MinEMAGapPips   = 0;              // Jarak minimum EMA7-EMA28 (pip, 0 = off) - elak pasaran flat

input group "=== Penapis Timeframe Besar ==="
input bool            UseHTFFilter    = true;           // Guna penapis EMA timeframe besar
input ENUM_TIMEFRAMES HTF             = PERIOD_H1;      // Timeframe besar (EMA kuning atas = buy sahaja)

input group "=== TP / SL ==="
input double        TPPips            = 5;         // Take profit (pip)
input double        SLPips            = 10;        // Stop loss (pip)
input double        BreakEvenPips     = 0;         // Alih SL ke entry bila untung X pip (0 = off)
input int           MaxHoldMinutes    = 0;         // Tutup paksa selepas X minit (0 = off)

input group "=== Lot ==="
input double        LotSize           = 0.01;      // Lot tetap (jika RiskPercent = 0)
input double        RiskPercent       = 0;         // Risiko % balance setiap trade ikut SL (0 = guna lot tetap)

input group "=== Waktu Trade (MYT) ==="
input int           StartHourMYT      = 15;        // Mula trade (jam MYT)
input int           EndHourMYT        = 24;        // Berhenti buka trade (jam MYT, 24 = tengah malam)
input bool          CloseAtEnd        = false;     // Tutup posisi bila tamat waktu trade
input bool          TradeFriday       = true;      // Trade hari Jumaat
input ENUM_GMT_MODE GMTMode           = GMT_AUTO;  // Cara kira GMT offset broker
input int           ServerGMTOffset   = 2;         // GMT offset server broker (mode Manual)

input group "=== Had Harian ==="
input int           MaxTradesPerDay   = 30;        // Maksimum trade sehari
input int           MaxLossesPerDay   = 3;         // Berhenti selepas X loss sehari
input double        MaxDailyLossPct   = 0;         // Berhenti jika rugi hari ini >= % balance (0 = off)
input int           CooldownBars      = 1;         // Tunggu X candle selepas trade tutup

input group "=== Penapis Lain ==="
input double        MaxSpreadPips     = 3;         // Spread maksimum (pip)
input bool          UseNewsFilter     = true;      // Elak news USD impak tinggi (live sahaja)
input int           NewsMinutesBefore = 30;        // Berhenti X minit sebelum news
input int           NewsMinutesAfter  = 30;        // Sambung X minit selepas news

input group "=== Lain-lain ==="
input double        PipSizeOverride   = 0;         // Saiz 1 pip dalam harga (0 = auto)
input ulong         MagicNumber       = 515151;    // Magic number
input int           SlippagePoints    = 20;        // Slippage (points)
input string        TradeComment      = "EMAScalp";// Komen order

//--- globals
CTrade   trade;
int      hFast = INVALID_HANDLE, hMid = INVALID_HANDLE, hSlow = INVALID_HANDLE;
int      hHFast = INVALID_HANDLE, hHMid = INVALID_HANDLE, hHSlow = INVALID_HANDLE;
int      g_off       = 0;
datetime g_lastBar   = 0;
string   g_status    = "";

// statistik hari ini (dikira dari history)
int      g_tradesToday = 0;
int      g_lossesToday = 0;
double   g_plToday     = 0;
datetime g_lastClose   = 0;

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
double Pip()
  {
   if(PipSizeOverride > 0)
      return PipSizeOverride;
   string s = _Symbol;
   StringToUpper(s);
   if(StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0)
      return 0.1;                     // emas: 1 pip = 0.10
   if(StringFind(s, "XAG") >= 0 || StringFind(s, "SILVER") >= 0)
      return 0.01;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double pt  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5)
      return pt * 10.0;
   return pt;
  }

datetime NthSunday(int year, int month, int n)
  {
   MqlDateTime d;
   ZeroMemory(d);
   d.year = year;
   d.mon  = month;
   d.day  = 1;
   datetime t = StructToTime(d);
   TimeToStruct(t, d);
   int first = 1 + (7 - d.day_of_week) % 7;
   d.day  = first + 7 * (n - 1);
   d.hour = 0;
   d.min  = 0;
   d.sec  = 0;
   return StructToTime(d);
  }

bool IsUSDST(datetime t)
  {
   MqlDateTime d;
   TimeToStruct(t, d);
   return (t >= NthSunday(d.year, 3, 2) && t < NthSunday(d.year, 11, 1));
  }

int ServerOffsetHours()
  {
   if(GMTMode == GMT_MANUAL)
      return ServerGMTOffset;
   if(!MQLInfoInteger(MQL_TESTER))
     {
      long diff = (long)(TimeTradeServer() - TimeGMT());
      return (int)MathRound(diff / 3600.0);
     }
   return IsUSDST(TimeCurrent()) ? 3 : 2;
  }

datetime MYTToServer(datetime myt) { return (datetime)((long)myt - (long)(8 - g_off) * 3600); }
datetime ServerToMYT(datetime srv) { return (datetime)((long)srv + (long)(8 - g_off) * 3600); }

datetime MYTMidnight(datetime myt)
  {
   MqlDateTime d;
   TimeToStruct(myt, d);
   d.hour = 0;
   d.min  = 0;
   d.sec  = 0;
   return StructToTime(d);
  }

bool InTradingHours()
  {
   datetime myt = ServerToMYT(TimeCurrent());
   MqlDateTime d;
   TimeToStruct(myt, d);
   if(d.day_of_week == 0 || d.day_of_week == 6)
      return false;
   if(!TradeFriday && d.day_of_week == 5)
      return false;
   int nowMin   = d.hour * 60 + d.min;
   int startMin = StartHourMYT * 60;
   int endMin   = EndHourMYT * 60;
   if(startMin == endMin)
      return true;
   if(startMin < endMin)
      return (nowMin >= startMin && nowMin < endMin);
   return (nowMin >= startMin || nowMin < endMin);   // waktu merentas tengah malam
  }

double NormalizeLot(double lot)
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double mn   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double mx   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   lot = MathFloor(lot / step + 1e-9) * step;
   if(lot < mn)
      lot = mn;
   if(lot > mx)
      lot = mx;
   return NormalizeDouble(lot, 2);
  }

double CalcLot()
  {
   if(RiskPercent <= 0)
      return NormalizeLot(LotSize);
   double tickVal  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickVal <= 0 || tickSize <= 0)
      return NormalizeLot(LotSize);
   double riskMoney   = AccountInfoDouble(ACCOUNT_BALANCE) * RiskPercent / 100.0;
   double lossPerLot  = (SLPips * Pip() / tickSize) * tickVal;
   if(lossPerLot <= 0)
      return NormalizeLot(LotSize);
   return NormalizeLot(riskMoney / lossPerLot);
  }

bool GetVal(int handle, int shift, double &v)
  {
   double b[1];
   if(CopyBuffer(handle, 0, shift, 1, b) != 1)
      return false;
   v = b[0];
   return true;
  }

//+------------------------------------------------------------------+
//| Arah trend EMA: 1 buy, -1 sell, 0 tiada                          |
//+------------------------------------------------------------------+
int TrendDir(double f, double m, double s, ENUM_EMA_MODE mode)
  {
   switch(mode)
     {
      case EMA_YELLOW_VS_BOTH:
         if(f > m && f > s)
            return 1;
         if(f < m && f < s)
            return -1;
         break;
      case EMA_YELLOW_VS_MID:
         if(f > m)
            return 1;
         if(f < m)
            return -1;
         break;
      default: // EMA_FULL_STACK
         if(f > m && m > s)
            return 1;
         if(f < m && m < s)
            return -1;
         break;
     }
   return 0;
  }

int HTFDir()
  {
   if(!UseHTFFilter)
      return 0;
   double f, m, s;
   if(!GetVal(hHFast, 1, f) || !GetVal(hHMid, 1, m) || !GetVal(hHSlow, 1, s))
      return 0;
   return TrendDir(f, m, s, EMA_YELLOW_VS_BOTH);
  }

//+------------------------------------------------------------------+
//| Signal pada candle yang baru tutup: 1 buy, -1 sell, 0 tiada      |
//+------------------------------------------------------------------+
int GetSignal(string &why)
  {
   why = "";
   double f, m, s;
   if(!GetVal(hFast, 1, f) || !GetVal(hMid, 1, m) || !GetVal(hSlow, 1, s))
     {
      why = "data EMA belum sedia";
      return 0;
     }
   MqlRates r[];
   if(CopyRates(_Symbol, SignalTF, 1, 1, r) != 1)
     {
      why = "data candle belum sedia";
      return 0;
     }

   int trend = TrendDir(f, m, s, TrendMode);
   if(trend == 0)
     {
      why = "EMA tiada trend";
      return 0;
     }
   if(MinEMAGapPips > 0 && MathAbs(f - s) / Pip() < MinEMAGapPips)
     {
      why = "EMA terlalu rapat (pasaran flat)";
      return 0;
     }
   if(UseHTFFilter)
     {
      int h = HTFDir();
      if(h != trend)
        {
         why = "EMA timeframe besar tak sama arah";
         return 0;
        }
     }

   double touch = (PullbackTo == PB_MID) ? m : f;

   if(trend > 0)
     {
      bool pulled   = (r[0].low <= touch);
      bool rejected = (r[0].close > f);
      bool candleOK = !RequireCandleDir || (r[0].close > r[0].open);
      if(pulled && rejected && candleOK)
        {
         why = "trend naik + pullback ke EMA";
         return 1;
        }
      why = "trend naik - tunggu pullback ke EMA";
     }
   else
     {
      bool pulled   = (r[0].high >= touch);
      bool rejected = (r[0].close < f);
      bool candleOK = !RequireCandleDir || (r[0].close < r[0].open);
      if(pulled && rejected && candleOK)
        {
         why = "trend turun + pullback ke EMA";
         return -1;
        }
      why = "trend turun - tunggu pullback ke EMA";
     }
   return 0;
  }

//+------------------------------------------------------------------+
//| News USD impak tinggi (kalendar MT5, live sahaja)                |
//+------------------------------------------------------------------+
bool NewsBlackout()
  {
   if(!UseNewsFilter || MQLInfoInteger(MQL_TESTER))
      return false;
   static datetime lastCheck = 0;
   static bool     cached    = false;
   datetime now = TimeTradeServer();
   if(now - lastCheck < 60)
      return cached;
   lastCheck = now;
   cached    = false;

   MqlCalendarValue vals[];
   datetime from = (datetime)((long)now - (long)NewsMinutesAfter * 60);
   datetime to   = (datetime)((long)now + (long)NewsMinutesBefore * 60);
   int n = CalendarValueHistory(vals, from, to, NULL, "USD");
   for(int i = 0; i < n; i++)
     {
      MqlCalendarEvent ev;
      if(CalendarEventById(vals[i].event_id, ev) && ev.importance == CALENDAR_IMPORTANCE_HIGH)
        {
         cached = true;
         break;
        }
     }
   return cached;
  }

//+------------------------------------------------------------------+
//| Statistik hari ini (MYT) dari history                            |
//+------------------------------------------------------------------+
void UpdateDailyStats()
  {
   g_tradesToday = 0;
   g_lossesToday = 0;
   g_plToday     = 0;
   g_lastClose   = 0;

   datetime from = MYTToServer(MYTMidnight(ServerToMYT(TimeCurrent())));
   if(!HistorySelect(from, TimeCurrent() + 3600))
      return;

   for(int i = 0; i < HistoryDealsTotal(); i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0)
         continue;
      if(HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol)
         continue;
      if(HistoryDealGetInteger(d, DEAL_MAGIC) != (long)MagicNumber)
         continue;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_IN)
         g_tradesToday++;
      else
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
           {
            double pl = HistoryDealGetDouble(d, DEAL_PROFIT) +
                        HistoryDealGetDouble(d, DEAL_SWAP) +
                        HistoryDealGetDouble(d, DEAL_COMMISSION);
            g_plToday += pl;
            if(pl < 0)
               g_lossesToday++;
            datetime t = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
            if(t > g_lastClose)
               g_lastClose = t;
           }
     }
  }

//+------------------------------------------------------------------+
//| Posisi                                                           |
//+------------------------------------------------------------------+
ulong FindPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)MagicNumber)
         continue;
      return tk;
     }
   return 0;
  }

void ManagePosition(ulong tk)
  {
   if(!PositionSelectByTicket(tk))
      return;
   bool     isBuy  = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double   open   = PositionGetDouble(POSITION_PRICE_OPEN);
   double   sl     = PositionGetDouble(POSITION_SL);
   double   tp     = PositionGetDouble(POSITION_TP);
   datetime opened = (datetime)PositionGetInteger(POSITION_TIME);
   double   bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double   ask    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   // Tutup paksa ikut masa
   if(MaxHoldMinutes > 0 && (long)TimeCurrent() - (long)opened >= (long)MaxHoldMinutes * 60)
     {
      if(trade.PositionClose(tk, SlippagePoints))
         Print("Tutup: melebihi masa maksimum");
      return;
     }

   // Tutup bila tamat waktu trade
   if(CloseAtEnd && !InTradingHours())
     {
      if(trade.PositionClose(tk, SlippagePoints))
         Print("Tutup: tamat waktu trade");
      return;
     }

   // Break-even
   if(BreakEvenPips > 0)
     {
      double trig = BreakEvenPips * Pip();
      double be   = NormalizeDouble(open + (isBuy ? 1 : -1) * _Point * 2, _Digits);
      if(isBuy && bid - open >= trig && (sl < be || sl == 0))
         trade.PositionModify(tk, be, tp);
      if(!isBuy && open - ask >= trig && (sl > be || sl == 0))
         trade.PositionModify(tk, be, tp);
     }
  }

bool OpenTrade(int dir)
  {
   double lot = CalcLot();
   double pip = Pip();
   bool ok;
   if(dir > 0)
     {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl  = NormalizeDouble(ask - SLPips * pip, _Digits);
      double tp  = NormalizeDouble(ask + TPPips * pip, _Digits);
      ok = trade.Buy(lot, _Symbol, ask, sl, tp, TradeComment);
     }
   else
     {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl  = NormalizeDouble(bid + SLPips * pip, _Digits);
      double tp  = NormalizeDouble(bid - TPPips * pip, _Digits);
      ok = trade.Sell(lot, _Symbol, bid, sl, tp, TradeComment);
     }
   uint rc = trade.ResultRetcode();
   if(!ok || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED))
     {
      PrintFormat("Gagal buka %s: %d %s", dir > 0 ? "BUY" : "SELL", rc, trade.ResultRetcodeDescription());
      return false;
     }
   PrintFormat("Buka %s lot %.2f", dir > 0 ? "BUY" : "SELL", lot);
   return true;
  }

//+------------------------------------------------------------------+
//| Cuba entry (dipanggil sekali setiap candle baru)                 |
//+------------------------------------------------------------------+
void TryEntry()
  {
   if(!InTradingHours())
     {
      g_status = StringFormat("Luar waktu trade (%02d:00 - %02d:00 MYT)", StartHourMYT, EndHourMYT % 24);
      return;
     }
   UpdateDailyStats();
   if(g_tradesToday >= MaxTradesPerDay)
     {
      g_status = "Had trade harian dicapai - sambung esok";
      return;
     }
   if(g_lossesToday >= MaxLossesPerDay)
     {
      g_status = StringFormat("%d loss hari ini - berhenti sampai esok", g_lossesToday);
      return;
     }
   if(MaxDailyLossPct > 0 && g_plToday <= -AccountInfoDouble(ACCOUNT_BALANCE) * MaxDailyLossPct / 100.0)
     {
      g_status = "Had rugi harian dicapai - berhenti sampai esok";
      return;
     }
   if(CooldownBars > 0 && g_lastClose > 0 &&
      (long)TimeCurrent() - (long)g_lastClose < (long)CooldownBars * PeriodSeconds(SignalTF))
     {
      g_status = "Cooldown selepas trade";
      return;
     }
   double spr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / Pip();
   if(MaxSpreadPips > 0 && spr > MaxSpreadPips)
     {
      g_status = StringFormat("Spread tinggi (%.1f pip)", spr);
      return;
     }
   if(NewsBlackout())
     {
      g_status = "News USD impak tinggi - berhenti sementara";
      return;
     }

   string why;
   int sig = GetSignal(why);
   g_status = why;
   if(sig != 0 && OpenTrade(sig))
     {
      g_status = (sig > 0 ? "BUY: " : "SELL: ") + why;
      UpdateDailyStats();
     }
  }

//+------------------------------------------------------------------+
//| Paparan                                                          |
//+------------------------------------------------------------------+
void Dashboard()
  {
   double f = 0, m = 0, s = 0;
   GetVal(hFast, 1, f);
   GetVal(hMid, 1, m);
   GetVal(hSlow, 1, s);
   int tr  = TrendDir(f, m, s, TrendMode);
   int htf = HTFDir();
   double spr = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / Pip();

   string txt = "=== EMA Scalper ===\n";
   txt += StringFormat("Masa MYT : %s  (server GMT%+d)  %s\n",
                       TimeToString(ServerToMYT(TimeCurrent()), TIME_DATE | TIME_MINUTES), g_off,
                       InTradingHours() ? "[WAKTU TRADE]" : "[TUTUP]");
   txt += StringFormat("Trend %s : %s", EnumToString(SignalTF), tr > 0 ? "NAIK" : (tr < 0 ? "TURUN" : "tiada"));
   if(UseHTFFilter)
      txt += StringFormat("   |   %s : %s", EnumToString(HTF), htf > 0 ? "NAIK" : (htf < 0 ? "TURUN" : "tiada"));
   txt += "\n";
   txt += StringFormat("Spread   : %.1f pip (max %.1f)\n", spr, MaxSpreadPips);
   txt += StringFormat("Hari ini : %d trade | %d loss | P/L %.2f\n", g_tradesToday, g_lossesToday, g_plToday);
   txt += StringFormat("TP/SL    : %.0f / %.0f pip\n", TPPips, SLPips);
   txt += "Status   : " + g_status;
   Comment(txt);
  }

//+------------------------------------------------------------------+
//| Event handlers                                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(TPPips <= 0 || SLPips <= 0 || LotSize <= 0 || MaxTradesPerDay < 1 || MaxLossesPerDay < 1 ||
      StartHourMYT < 0 || StartHourMYT > 23 || EndHourMYT < 0 || EndHourMYT > 24)
     {
      Print("Input tidak sah");
      return INIT_PARAMETERS_INCORRECT;
     }

   hFast = iMA(_Symbol, SignalTF, EMA_Fast, 0, MODE_EMA, PRICE_CLOSE);
   hMid  = iMA(_Symbol, SignalTF, EMA_Mid,  0, MODE_EMA, PRICE_CLOSE);
   hSlow = iMA(_Symbol, SignalTF, EMA_Slow, 0, MODE_EMA, PRICE_CLOSE);
   if(hFast == INVALID_HANDLE || hMid == INVALID_HANDLE || hSlow == INVALID_HANDLE)
     {
      Print("Gagal cipta handle EMA");
      return INIT_FAILED;
     }
   if(UseHTFFilter)
     {
      hHFast = iMA(_Symbol, HTF, EMA_Fast, 0, MODE_EMA, PRICE_CLOSE);
      hHMid  = iMA(_Symbol, HTF, EMA_Mid,  0, MODE_EMA, PRICE_CLOSE);
      hHSlow = iMA(_Symbol, HTF, EMA_Slow, 0, MODE_EMA, PRICE_CLOSE);
      if(hHFast == INVALID_HANDLE || hHMid == INVALID_HANDLE || hHSlow == INVALID_HANDLE)
        {
         Print("Gagal cipta handle EMA timeframe besar");
         return INIT_FAILED;
        }
     }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   g_lastBar = 0;
   PrintFormat("EA Scalper dimulakan. 1 pip = %s", DoubleToString(Pip(), _Digits));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   int handles[6];
   handles[0] = hFast;
   handles[1] = hMid;
   handles[2] = hSlow;
   handles[3] = hHFast;
   handles[4] = hHMid;
   handles[5] = hHSlow;
   for(int i = 0; i < 6; i++)
      if(handles[i] != INVALID_HANDLE)
         IndicatorRelease(handles[i]);
   Comment("");
  }

void OnTick()
  {
   g_off = ServerOffsetHours();

   ulong tk = FindPosition();
   if(tk > 0)
     {
      ManagePosition(tk);
      g_status = "Posisi aktif - tunggu TP/SL";
     }

   // Semak signal sekali sahaja setiap candle baru
   datetime bar = iTime(_Symbol, SignalTF, 0);
   if(bar != g_lastBar)
     {
      g_lastBar = bar;
      if(FindPosition() == 0)
         TryEntry();
      else
         UpdateDailyStats();
     }

   Dashboard();
  }
//+------------------------------------------------------------------+
