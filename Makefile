LDFLAGS = -lwiringPi

ALL: waterfuse

install: ALL
	sudo cp waterfuse /usr/local/bin
