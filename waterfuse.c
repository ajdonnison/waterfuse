/**
 * Monitor a water flow meter and make decisions about
 * the need for cutting off flow.
 *
 * An interrupt handler counts clicks from the flow meter
 * after so many litres happen 
 */
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>
#include <wiringPi.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdarg.h>
#include <time.h>

#define FLOW_METER 0 // Pin for flow meter input
#define POWER_RELAY 1 // Pin for relay to pump output
#define RESET_BUTTON 2
#define PRESSURE_SENSOR 3
#define CLICKS_PER_LITRE 450 // Number of pulses per litre
#define MAX_FLOW 200 // Maximum number of litres in a given time period
#define RESET_PERIOD 600 // Quiescent time to reset counters
#define MAX_TIME 900 // Time during which the max flow can be achieved

volatile unsigned int clicks = 0;
volatile unsigned int reset = 0;
unsigned char triggered = 0;
unsigned char counting = 0;
int last_click_time = 0;
int last_click_count = 0;
int first_click_time = 0;
int total_clicks = 0;
int clicks_per_litre = CLICKS_PER_LITRE;
int max_litres = MAX_FLOW;
int reset_period = RESET_PERIOD;
int time_limit = MAX_TIME;
int daemonise = 1;
int verbose = 0;

void
handleClick(void) {
  clicks++;
}

void
handleReset(void) {
  reset = 1;
}

void rollLog() {
  int outfd;
  outfd = open("/var/log/waterfuse.log",
    O_WRONLY | O_APPEND | O_CREAT,
    S_IRUSR | S_IWUSR | S_IRGRP | S_IROTH
  );
  close(1);
  close(2);
  dup2(outfd, 1);
  dup2(outfd, 2);
  close(outfd);
}

void
readConfig(void) {
  FILE * cfg;
  char buf[1024];
  int val;

  if ((cfg = fopen("/etc/waterfuse/waterfuse.conf", "r")) != NULL) {
    while (fscanf(cfg, "%s %d", &buf, &val) != EOF) {
      if (strcmp("reset_period", buf) == 0) {
        reset_period = val;
      } else if (strcmp("max_time", buf) == 0) {
        time_limit = val * 60;
      } else if (strcmp("max_litres", buf) == 0) {
        max_litres = val;
      } else if (strcmp("clicks_per_litre", buf) == 0) {
        clicks_per_litre = val;
      } else if (strcmp("verbosity", buf) == 0) {
        verbose = val;
      }
    }
  }
}

void
printLog(int level, const char * fmt, ...) {
  va_list args;
  char buf[1024];
  struct tm * time_parts;
  time_t secs;

  if (level > verbose) {
    return;
  }
  // Get the current date/time
  time(&secs);
  time_parts = localtime(&secs);
  // Write out a date string
  strftime((char *)&buf, sizeof(buf), "%Y-%m-%d %H:%M:%S ", time_parts);
  printf(buf);

  va_start(args, fmt);
  vprintf(fmt, args);
  va_end(args);
  fflush(stdout);
}

void
writeState(const char * fmt, ...) {
  va_list args;
  char buf[1024];
  FILE * statefile;

  statefile = fopen("/var/un/waterfuse/waterfuse.state", "w");
  va_start(args, fmt);
  vfprintf(statefile, fmt, args);
  va_end(args);
  fclose(statefile);
}

void
showStats(int level) {
  int now;
  now = time(0);
  printLog(level, "last_click_time: %d seconds ago\n", now - last_click_time);
  printLog(level, "first_click_time: %d seconds ago\n", now - first_click_time);
  printLog(level, "last_click_count: %d\n", last_click_count);
  printLog(level, "total_litres: %d\n", total_clicks / clicks_per_litre);
}

void
showConfig(void) {
  printLog(0, "reset_period: %d\n", reset_period);
  printLog(0, "time_limit: %d\n", time_limit);
  printLog(0, "max_litres: %d\n", max_litres);
  printLog(0, "clicks_per_litre: %d\n", clicks_per_litre);
  printLog(0, "verbose: %d\n", verbose);
}

void
signalHandler(int sig) {
  switch (sig) {
    case SIGHUP:
      rollLog();
      readConfig();
      break;
    case SIGUSR1:
      reset = 2;
      break;
    case SIGUSR2:
      showStats(0);
      break;
    case SIGCONT:
      digitalWrite(POWER_RELAY, LOW);
      triggered=1;
      break;
    }
}

void
createPidFile(void) {
  int pid;
  FILE * pidfile;
  struct stat st;

  pid = getpid();
  if (stat("/var/run/waterfuse", &st) < 0) {
    mkdir("/var/run/waterfuse", 0755);
  }

  pidfile = fopen("/var/run/waterfuse/waterfuse.pid", "w");
  fprintf(pidfile, "%d\n", pid);
  fclose(pidfile);
}

int
main(int argc, char **argv) {
  unsigned int litres = 0;
  int stop_reason = 0;
  int opt;
  int now;
  int seconds_from_first, seconds, time_periods, new_clicks;
  struct sigaction sa;
  int total_litres;
  int pressure;
  char * reset_msg[3] = { "", "button", "signal" };
  char * stop_msg[3] = { "", "volume", "time" };

  // Grab config from our config file first
  readConfig();

  // Now allow command-line overrides
  while ((opt = getopt(argc, argv, "l:c:r:t:vd")) != -1) {
    switch (opt) {
      case 'l':
        max_litres = atoi(optarg);
	break;
      case 'c':
        clicks_per_litre = atoi(optarg);
	break;
      case 't':
        time_limit = atoi(optarg) * 60;
	break;
      case 'r':
        reset_period = atoi(optarg);
	break;
      case 'd':
        daemonise = 0;
	break;
      case 'v':
        verbose++;
	break;
    }
  }

  // Now we switch to daemon;
  if (daemonise) {
    close(0);
    rollLog();
    daemon(1, 1);
  }

  // And print out our config
  printLog(0, "Starting\n");
  writeState("started\tstartup\n");
  showConfig();

  // Create pidfile
  createPidFile();


  // Set up reset handler
  sa.sa_handler = signalHandler;
  sa.sa_flags = SA_RESTART|SA_NODEFER;
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGUSR1, &sa, NULL);
  sigaction(SIGUSR2, &sa, NULL);
  sigaction(SIGCONT, &sa, NULL);

  // Later versions die internally, no need to check result
  wiringPiSetup();

  // Set up ISR
  if (wiringPiISR(FLOW_METER, INT_EDGE_RISING, &handleClick) < 0) {
    fprintf(stderr, "Unable to create flow meter interrupt: %s\n", strerror(errno));
    return 1;
  }

  pinMode(RESET_BUTTON, INPUT);
  pullUpDnControl (RESET_BUTTON, PUD_UP);
  /*
  if (wiringPiISR(RESET_BUTTON, INT_EDGE_FALLING, &handleReset) < 0) {
    fprintf(stderr, "Unable to create pushbutton interrupt: %s\n", strerror(errno));
    return 1;
  }
  */

  // Set up output for relay and fire it up
  pinMode(POWER_RELAY, OUTPUT);
  // pinMode(PRESSURE_SENSOR, INPUT);
  digitalWrite(POWER_RELAY, HIGH);


  while (1) {
    now = time(0);
    /*
     * When we first fire up - counting is false, also after a rest
     * or after a period of inactivity, we set counting to false.
     * If we are counting (flow is happening) we need to check against
     * time of day and 
     */
    // pressure = analogRead(PRESSURE_SENSOR);
    // printLog(3, "Pressure returns %d\n", pressure);
    seconds = now - last_click_time;  
    new_clicks = clicks - last_click_count;
    last_click_count = clicks;
    total_clicks += new_clicks;
    total_litres = total_clicks / clicks_per_litre;
    litres = clicks / clicks_per_litre;
    printLog(3, "clicks: %d, litres: %d, triggered=%d, counting=%d, new=%d\n", clicks, litres, triggered, counting, new_clicks);
    if (triggered && digitalRead(RESET_BUTTON) == 0) {
      reset = 1;
    }
    if (reset) {
      triggered = 0;
      clicks = 0;
      counting = 0;
      last_click_count = 0;
      new_clicks = 0;
      last_click_time = now;
      first_click_time = now;
      printLog(2, "Turning pump on after reset by %s\n", reset_msg[reset]);
      writeState("started\t%s\n", reset_msg[reset]);
      reset = 0;
      digitalWrite(POWER_RELAY, HIGH);
    }
    if (!triggered) {
      if (counting) {
	if (! new_clicks ) {
	  if (seconds > reset_period) {
	    counting = 0;
	    clicks = 0;
	    last_click_count = 0;
	  }
	} else {
	  last_click_time = now;
	  seconds_from_first = last_click_time - first_click_time;
          stop_reason = 0;
          if (litres > max_litres) {
            stop_reason = 1;
          }
          if (seconds_from_first > time_limit) {
            stop_reason = 2;
          }
          if (stop_reason) {
	    triggered = 1;
	    printLog(2,"Turning pump off (%s) litres:%d, seconds:%d\n", stop_msg[stop_reason], litres, seconds_from_first);
            writeState("stopped\t%s\n", stop_msg[stop_reason]);
	    showStats(2);
	    digitalWrite(POWER_RELAY, LOW);
	  }
	}
      } else { // Not counting yet
	if ( new_clicks) {
	  counting = 1;
	  first_click_time = now;
	  last_click_time = now;
	}
      }
    }
    delay(1000);
  }

  writeState("stopped\tshutdown\n");

  return 0;
}
